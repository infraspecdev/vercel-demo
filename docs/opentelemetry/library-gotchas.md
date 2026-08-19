# Library and framework gotchas

Signatures that fail silently, version skew that breaks the build, and the Express field that lies during error handling.

Part of [OpenTelemetry on Vercel](./README.md), where **measured** and
**verified in production** are defined.

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
