# OpenTelemetry on Vercel: constraints and findings

Notes for instrumenting a plain Node/Express service on Vercel with ESM.

**measured** = verified in this repo against a local OTLP receiver, 2026-08-06.
Everything else is cited. Nothing is verified against a real deployment or real SigNoz.

## Contents

- [Free with no code](#free-with-no-code)
- [Does not work out of the box](#does-not-work-out-of-the-box)
- [Library gotchas](#library-gotchas)
- [Express gotchas](#express-gotchas)
- [Span naming](#span-naming)
- [Vercel limits](#vercel-limits)
- [Serverless lifecycle](#serverless-lifecycle)
- [PII](#pii)
- [Cost](#cost)

## Free with no code

**`fetch` is instrumented by default.** `@vercel/otel` patches `fetch`. `supabase-js` uses
`fetch`. So every Supabase query is a span, with no wrapper code.

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
