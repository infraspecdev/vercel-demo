# What arrives free, and what does not work out of the box

What `@vercel/otel` gives you for nothing, and the three things that look configured but are not.

Part of [OpenTelemetry on Vercel](./README.md), where **measured** and
**verified in production** are defined.

## Free with no code

**`fetch` is instrumented by default.** `@vercel/otel` patches `fetch`. `supabase-js` uses
`fetch`. So every Supabase query is a span, with no wrapper code. Instrumented is not the
same as propagated — see [Outbound trace context](./trace-propagation.md#outbound-trace-context).

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
