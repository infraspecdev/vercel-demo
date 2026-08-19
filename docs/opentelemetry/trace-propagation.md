# Outbound trace context

Getting a `traceparent` onto Supabase requests, and which span the trace id actually names.

Part of [OpenTelemetry on Vercel](./README.md), where **measured** and
**verified in production** are defined.

## `@vercel/otel` does not propagate to third-party hosts

Inbound propagation is free — `HttpInstrumentation` extracts `traceparent`. Outbound is not.
`@vercel/otel`'s `shouldPropagate` injects only when the URL is `https:` and the host matches
`VERCEL_URL` or `VERCEL_BRANCH_URL`, plus anything listed in `propagateContextUrls`. A
Supabase host is none of those.

**measured.** Every Supabase call was a span locally and carried no `traceparent` on the wire.

Two ways to fix it:

| | Mechanism | Injects the id of |
| --- | --- | --- |
| `supabase-js` | `import '@supabase/supabase-js/tracing'` + `tracePropagation: true` | the enclosing service span |
| `@vercel/otel` | `fetch: { propagateContextUrls: [/\.supabase\.co/] } ` | the `fetch` span |

This repo uses the first. The library enforces the domain allowlist itself
(`*.supabase.co`, `*.supabase.in`, `localhost`), so there is no host pattern to keep
correct, and a custom `fetch` to a third-party host is never tagged.

Do not do both. `@vercel/otel` injects after `supabase-js` has built the headers and
overwrites what it finds.

## The header names the service span, not the `fetch` span

`supabase-js` reads the active context when it builds its headers, which is before the
patched `fetch` opens a span. So the `traceparent` it sends points at whatever span is
already active.

**measured**, with the OTLP payload captured to resolve the span id:

```
traceparent  00-71197e080c044972a085b1bb9827c669-66dbeabc20e72bbc-01
exported     GET[032e3154…]
             fetch GET .../rest/v1/items[accd3bd5…]
             inventory.items.list[66dbeabc20e72bbc]   ← the id in the header
```

**verified in production.** Supabase logged
`traceparent: 00-9035657b92a96badd19a59a65056f655-6ce0929643a51bc6-01`, and
`6ce0929643a51bc6` resolves in SigNoz to `inventory.stock.byLocation` — with the `fetch`
span (`c698c7d3…`) as its child:

```
GET /api/stock                        [f9b9cb36…]  488.4ms
├─ inventory.locations.byCode         [61c0912e…]  240.5ms
│  └─ fetch GET .../rest/v1/locations [f2b55e7a…]  240.3ms
└─ inventory.stock.byLocation         [6ce09296…]  246.6ms  ← the id in the header
   └─ fetch GET .../rest/v1/stock     [c698c7d3…]  246.4ms
```

`propagateContextUrls` would name the `fetch` span instead. Trace id is identical either
way, and trace id is what Supabase's logs key on, so the difference is only visible if
exact parent-child nesting across the boundary is wanted.

## Where the trace id lands in Supabase's logs

Supabase's own documentation states the `trace_id` "appears in API Gateway logs" without
naming a field, giving a query, or describing how to verify it. It does arrive, in three
places at once.

**verified in production**, from one `edge_logs` row:

| Key | Value |
| --- | --- |
| `request.headers.traceparent` | `00-9035657b…-6ce09296…-01` — the raw header |
| `trace_id` | `9035657b92a96badd19a59a65056f655` — parsed out by Supabase |
| `span_id` | `6ce0929643a51bc6` — parsed out by Supabase |

All three live inside `log_attributes`, not at the top level of the row.

**The dashboard's row summary does not show them.** Expanding a log entry in the unified
Logs (BETA) view renders `"headers": {}` — empty — even while the user agent is visible in
`event_message`. That view is a curated projection. Read the full `log_attributes` map, or
query it:

```sql
select timestamp,
       log_attributes['request.path']                 as path,
       log_attributes['trace_id']                     as trace_id,
       log_attributes['request.headers.traceparent']   as traceparent
from logs
where source = 'edge_logs'
order by timestamp desc
limit 20
```

Run that in **Logs → Explorer** (`/logs/explorer`), not the SQL Editor. The SQL Editor
queries Postgres and answers `42P01: relation "logs" does not exist`, which reads like a
broken query rather than the wrong surface.

Two other fields on the same row make the correlation worth having:

| Key | Meaning |
| --- | --- |
| `response.origin_time` | Supabase's own server-side duration, in ms |
| `request.headers.x_client_info` | `supabase-js/2.112.1; runtime=node; runtime-version=24.18.0` |

`response.origin_time` is the point of the whole exercise. For the trace above: the client
`fetch` span measured 246.4ms and Supabase reported 232ms, so **≈14ms was network and
client overhead**. That split cannot be computed from either side alone.

## The runtime import and the option must be in the same file

`tracePropagation: true` without `import '@supabase/supabase-js/tracing'` is not an error.
It logs a one-time warning and sends no headers. The import registers a process-global
extractor under `Symbol.for('@supabase/supabase-js.traceContextExtractor')`; the option
only reads it.

Keeping both next to `createClient` — rather than putting the import in
`instrumentation.js` — means they cannot drift apart, and no import-order rule has to hold.

## It is a no-op when telemetry is off

The import is unconditional. With no SDK registered, the extractor injects through the
no-op propagator, finds no `traceparent`, and returns `null`.

**measured.** With `OTEL_EXPORTER_OTLP_ENDPOINT` unset: no `traceparent`, no `tracestate`,
no `baggage`, no warning. The "telemetry off behaves exactly as before" property holds
without a conditional.

## `respectSamplingDecision` defaults to `true`

Trace headers are skipped when the `traceparent` sampled flag is `0`. Nothing is sampled
out in this repo, so the default changes nothing today.

It becomes a real choice the moment a sampler is added: unsampled requests stop carrying a
`trace_id` into Supabase's logs, which is the correlation the feature exists for. Set it to
`false` to tag every request regardless.

## Requirements

| Thing | Version |
| --- | --- |
| `@supabase/supabase-js` | 2.106+ for the option, **2.112+** for the `/tracing` subpath |
| `@opentelemetry/api` | any; already a direct dependency here |
| CDN / UMD build | not supported |
