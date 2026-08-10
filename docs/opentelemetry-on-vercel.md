# OpenTelemetry on Vercel: constraints and findings

Notes for instrumenting a plain Node/Express service on Vercel with ESM.

**measured** = verified in this repo against a local OTLP receiver, 2026-08-06 to 2026-08-07.
Everything else is cited. Nothing is verified against a real deployment or real SigNoz.

## Contents

- [Free with no code](#free-with-no-code)
- [Does not work out of the box](#does-not-work-out-of-the-box)
- [Outbound trace context](#outbound-trace-context)
- [Semantic conventions are split](#semantic-conventions-are-split)
- [Library gotchas](#library-gotchas)
- [Express gotchas](#express-gotchas)
- [Span naming](#span-naming)
- [Vercel limits](#vercel-limits)
- [Serverless lifecycle](#serverless-lifecycle)
- [PII](#pii)
- [Cost](#cost)

## Free with no code

**`fetch` is instrumented by default.** `@vercel/otel` patches `fetch`. `supabase-js` uses
`fetch`. So every Supabase query is a span, with no wrapper code. Instrumented is not the
same as propagated — see [Outbound trace context](#outbound-trace-context).

**Resource attributes come from the environment.** `@vercel/otel` sets these on every span:

| Attribute | Source |
| --- | --- |
| `deployment.environment.name` | `VERCEL_ENV` |
| `cloud.region` | `VERCEL_REGION` |
| `cloud.provider` | `"vercel"` |
| `vcs.ref.head.revision` | `VERCEL_GIT_COMMIT_SHA` |
| `deployment.id`, `service.version` | `VERCEL_DEPLOYMENT_ID` |

Do not set these by hand. Duplicated config drifts.

**`HttpInstrumentation` extracts inbound `traceparent`.** No propagation middleware needed.
**measured** — a request sent with trace `5555…` produced spans on that trace.

## Does not work out of the box

### `registerOTel` alone is not enough

**measured.** One request produced **three separate parentless traces**, one per Supabase
call. There is no request span to hang them from.

Add `@opentelemetry/instrumentation-http`. It patches `node:http`, a Node builtin. Builtins
patch fine under ESM with no loader flag.

### `instrumentation-express` cannot be used

It works and needs no application code. **measured** under
`--experimental-loader=@opentelemetry/instrumentation/hook.mjs`:

```
GET /api/reports/low-stock  72.4ms  http.route=/api/reports/low-stock
  middleware - jsonParser        0.6ms
  request handler - /api/reports/low-stock  67.9ms
```

Three reasons it is unavailable:

1. It patches `express`, a userland package. Under ESM that needs a loader hook at process
   start.
2. Vercel gives no way to pass Node flags to the function runtime.
3. It cannot self-register. ESM loads the whole module graph before any module body runs, so
   `express` is already resolved.

`--experimental-loader` is also deprecated. Node points to `register()` from `node:module`.

**On CommonJS this all goes away.** `require`-hook patching needs no flag. ESM is what costs
you Express auto-instrumentation, not Vercel.

### `attributesFromHeaders` does not reach third-party spans

`registerOTel` accepts `attributesFromHeaders: { 'vercel.request_id': 'x-vercel-id' }`.

**measured** with the header set: the attribute never appeared. The option only decorates
spans `@vercel/otel` creates itself. Read the header in middleware instead.

## Outbound trace context

### `@vercel/otel` does not propagate to third-party hosts

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

### The header names the service span, not the `fetch` span

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

`propagateContextUrls` would name the `fetch` span instead. Trace id is identical either
way, and trace id is what Supabase's logs key on, so the difference is only visible if
exact parent-child nesting across the boundary is wanted.

### The runtime import and the option must be in the same file

`tracePropagation: true` without `import '@supabase/supabase-js/tracing'` is not an error.
It logs a one-time warning and sends no headers. The import registers a process-global
extractor under `Symbol.for('@supabase/supabase-js.traceContextExtractor')`; the option
only reads it.

Keeping both next to `createClient` — rather than putting the import in
`instrumentation.js` — means they cannot drift apart, and no import-order rule has to hold.

### It is a no-op when telemetry is off

The import is unconditional. With no SDK registered, the extractor injects through the
no-op propagator, finds no `traceparent`, and returns `null`.

**measured.** With `OTEL_EXPORTER_OTLP_ENDPOINT` unset: no `traceparent`, no `tracestate`,
no `baggage`, no warning. The "telemetry off behaves exactly as before" property holds
without a conditional.

### `respectSamplingDecision` defaults to `true`

Trace headers are skipped when the `traceparent` sampled flag is `0`. Nothing is sampled
out in this repo, so the default changes nothing today.

It becomes a real choice the moment a sampler is added: unsampled requests stop carrying a
`trace_id` into Supabase's logs, which is the correlation the feature exists for. Set it to
`false` to tag every request regardless.

### Requirements

| Thing | Version |
| --- | --- |
| `@supabase/supabase-js` | 2.106+ for the option, **2.112+** for the `/tracing` subpath |
| `@opentelemetry/api` | any; already a direct dependency here |
| CDN / UMD build | not supported |

## Semantic conventions are split

The two instrumentations in this app name the same things differently. **measured**, from
the exported OTLP payload of a single request:

| Concept | Request span<br>`instrumentation-http` 0.221 | Supabase span<br>`@vercel/otel/fetch` 2.1.3 |
| --- | --- | --- |
| method | `http.request.method` | `http.method` |
| status | `http.response.status_code` | `http.status_code` |
| host | `server.address` | `http.host` |
| path | `url.path` | — (only `http.url`, full) |
| peer | `network.peer.address` | `net.peer.name` |

HTTP semconv stabilised in v1.23.0. `instrumentation-http` finished its migration and now
emits the stable names only. `@vercel/otel`'s bundled fetch instrumentation still emits the
old v1.7.0 names.

**A query on `http.response.status_code` silently misses every Supabase span.** That is the
practical cost, and it is a wrong answer rather than an empty one.

### No environment variable fixes this

`OTEL_SEMCONV_STABILITY_OPT_IN` (`http`, `http/dup`) was the migration knob. Both ends of
it are gone here:

- `@vercel/otel` 2.1.3 — the string does not appear anywhere in its bundle. Its fetch
  instrumentation is hardcoded to the old names.
- `instrumentation-http` 0.221 — no stability-handling code left in the build output.
  Stable-only.

### `@vercel/otel` also puts the full URL in the span name

```
fetch GET http://…/rest/v1/items?select=id%2Csku%2Cname%2C…&order=sku.asc&limit=1
```

Every distinct query string is a distinct span name. That is the unbounded-cardinality
mistake [Span naming](#span-naming) warns about, arriving by default rather than by
someone's edit. It also puts PostgREST filter values in the span *name*, not just the
attributes — see [PII](#pii).

### Replacing the fetch instrumentation was prototyped and rejected

`@opentelemetry/instrumentation-undici` 0.31 emits stable semconv and names client spans
`GET`, both correct. Node's global `fetch` is undici, and it hooks `diagnostics_channel`
rather than patching a module — so unlike `instrumentation-express`, it needs no loader
flag. It looked like the clean fix. **measured**, five configurations:

| `instrumentations` | request span | client spans | semconv | `traceparent` → Supabase | → third party |
| --- | --- | --- | --- | --- | --- |
| `['auto', http]` — current | ✅ | `@vercel/otel/fetch` | old | 1 | none |
| `[undici, http]` | **gone** | undici | stable | **2** | yes |
| `[http]` | **gone** | none | — | 1 | none |
| `['auto', undici, http]` | ✅ | **both, duplicated** | mixed | **2** | yes |
| `['auto', undici, http]` + `fetch: { ignoreUrls: ['*'] }` | ✅ | undici | stable | 1 | yes |

Three findings, none of them anticipated:

**`'auto'` is load-bearing.** Remove the string and `HttpInstrumentation` produces nothing
— no request span, no spans at all — even though the instance is still passed explicitly.
The `[http]` row isolates it: this is not a conflict with undici, it is the missing
`'auto'`. Without a request span the trace reverts to one parentless trace per Supabase
call, which is the failure
[`registerOTel` alone is not enough](#registerotel-alone-is-not-enough) describes.

**Undici appends the trace header rather than replacing it.** With `supabase-js`
propagation also on:

```
traceparent: 00-82e0…-4dee4e9c54c54e07-01, 00-82e0…-f18cbbd1d8c292fb-01
```

Two values, comma-joined. Not a valid `traceparent`. Adopting undici therefore means
turning `tracePropagation` back off in `src/supabase.js`.

**Undici propagates to every host.** It has no domain allowlist. The current setup sends
trace headers only to Supabase, because `supabase-js` enforces that itself. Switching
widens that to anything the service fetches.

Only the last row works, and it costs a dependency, an `ignoreUrls: ['*']` incantation, the
loss of the `supabase-js` allowlist, and reverting
[Outbound trace context](#outbound-trace-context). Not worth consistent attribute names.

**Left as-is deliberately.** Know both key sets when querying.

A span processor that copies the old keys onto the stable names is the cheaper option if
this ever becomes painful — `spanProcessors` accepts `[SpanProcessor | "auto"]`, so one can
be added alongside the default. It relies on the span still being mutable in `onEnd`, which
holds in practice but is not in the SDK contract.

### Unresolved

Whether dropping `@vercel/otel`'s fetch spans would empty the **External APIs** section of
Vercel's Observability tab. The fetch instrumentation has no `getVercelRequestContext`
coupling anywhere in its bundle, which suggests that section is platform-fed rather than
span-fed — but that is inference. Only a deployment settles it.

## Library gotchas

### `sdk-logs` processors take an options object

```js
new BatchLogRecordProcessor({ exporter })   // correct
new BatchLogRecordProcessor(exporter)       // constructs, then drops every record
```

The positional form throws nothing and exports nothing. **measured.** The constructor reads
`options.exporter`. A positional argument leaves it undefined.

### Keep OTel versions aligned

`@vercel/otel` 2.1.3 peer ranges:

| Package | Range |
| --- | --- |
| `@opentelemetry/api` | `>=1.9.0 <2.0.0` |
| `sdk-logs`, `api-logs`, `instrumentation` | `>=0.200.0 <0.300.0` |
| `resources`, `sdk-trace-base`, `sdk-metrics` | `>=2.0.0 <3.0.0` |

The `0.2xx` packages move together. Mixing minors across them breaks silently.

## Express gotchas

### `req.baseUrl` is reset when an error unwinds

`req.baseUrl` is only correct inside the router. A thrown handler unwinds to the app and
resets it to `''`. That happens before `res.on('finish')` fires.

**measured:**

```
[handler]      baseUrl="/api" route=/ok           ← success
[finish]       baseUrl="/api" route=/ok

[handler]      baseUrl="/api" route=/movements    ← throws
[errorhandler] baseUrl=""     route=/movements    ← reset here
[finish]       baseUrl=""     route=/movements
```

Computing a route as `req.baseUrl + req.route.path` in a finish listener mislabels every
error response. If the truncated path matches a real route on another router, two endpoints
silently merge.

Capture the mount path while it is valid:

```js
function recordMount(req, _res, next) {
  req.mountPath = req.baseUrl
  next()
}

app.use('/api', recordMount, apiRoutes)
```

## Span naming

From the [HTTP semantic conventions](https://opentelemetry.io/docs/specs/semconv/http/http-spans/):

| Item | Level |
| --- | --- |
| Span name `{method} {http.route}` | SHOULD |
| Span name `{method}` when no route is available | SHOULD |
| `http.route` attribute | Conditionally Required — "if and only if it's available" |
| `http.route` low cardinality | MUST |

A span named `GET` with no `http.route` is spec-compliant. The spec says `http.route` "MUST
NOT be populated when this is not supported by the HTTP server framework".

So naming spans after the route is useful, not required. Without it every endpoint shares a
few span names. Per-route latency and error rate become unqueryable.

**Never put an id in a span name.** `/items/7` as a name gives unbounded distinct names. Ids
go in attributes. Patterns go in names.

## Vercel limits

From [Vercel's tracing docs](https://vercel.com/docs/tracing):

| Limit | Value |
| --- | --- |
| Trace data per request | 10 MB compressed |
| Span size | over 1 MB compressed is dropped, after attribute truncation |
| Edge runtime custom spans | not supported |
| Session Tracing | 1M spans/month/team, all plans |
| Trace Drains | Pro or Enterprise, $0.50 per volume unit |

Sampling: if a request carries `traceparent`, both the inbound decision and Vercel's rules
must agree. An upstream "not sampled" wins.

**Never run a Trace Drain and an in-code exporter together.** Spans arrive twice by
different paths and appear duplicated.

## Serverless lifecycle

**Use `@vercel/otel`, not a raw `NodeSDK`.** Functions freeze between requests. An unflushed
batch exporter loses its buffer. `@vercel/otel` handles that lifecycle. Vercel also notes
that manual SDK setup forfeits Session Tracing and Trace Drains.

**Cold starts are partly observable.** A module-level flag finds the first request through
an instance. `process.uptime()` at that point measures initialisation. Neither sees
container boot before Node started. Treat `faas.init_duration_ms` as a floor.

**Time before your code runs is not observable.** CDN routing, queueing and boot all happen
first. No header carries the edge receive timestamp. Only Trace Drains see that layer, and
they need Pro.

## PII

Span and log attributes are exported to a third party. Anything on a span leaves the system.

- **`fetch` spans record the full URL, including the query string.** PostgREST puts filters
  there. `?email=eq.someone@example.com` would be exported verbatim. This is the least
  obvious leak — no one wrote code to add it.
- **Identifiers are data.** `inventory.item_id` is harmless. A customer id, an account
  number, or anything that identifies a person is not.
- **Error messages are recorded.** `span.recordException` captures the message, which often
  contains the value that caused the failure.
- **Redact in the exporter, not by review discipline.** An in-code exporter can filter before
  export. A Trace Drain forwards what the platform captured. If redaction is a requirement,
  export in code regardless of plan.

None of this affects the seeded demo data. It applies the moment the pattern touches real
records.

## Cost

Span volume drives cost. Fan-out multiplies it. One `/api/reports/low-stock` request is five
spans here. An endpoint looping over items would be one span per iteration.

Controls, cheapest first:

1. **Sample.** Use `traceSampler`, or `OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG`.
2. **Do not instrument hot loops.** Spans are for operations worth naming.
3. **Watch attribute size.** The per-span ceiling is 1 MB. Never attach result sets.

Demo traffic is nowhere near Vercel's 1M spans/month.

## Related

- `README.md` — configuration and what this service captures
