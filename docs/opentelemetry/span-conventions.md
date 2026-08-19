# Semantic conventions and span naming

Two instrumentations naming the same things differently, the unbounded span name that arrives by default, and the rules for naming spans.

Part of [OpenTelemetry on Vercel](./README.md), where **measured** and
**verified in production** are defined.

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
attributes — see [PII](./platform-limits.md#pii).

Known upstream as [vercel/otel#120](https://github.com/vercel/otel/issues/120), open since
September 2024 with no maintainer reply. `resource.name` already strips the query — the
helper is called two lines above the span name that does not use it:

```js
// packages/otel/src/instrumentations/fetch.ts, on main
247:  : removeSearch(url.toString());                                      // resource.name
249:  const spanName = name ?? `${fetchType} ${method} ${url.toString()}`;  // span name
```

**Fixed here by a span processor.** `src/telemetry/fetchSpanNames.js` renames these spans in
`onStart`, to the URL path alone:

```
fetch GET /rest/v1/items
```

Four different queries against `items` — two list filters and two ids — went from four
span names to one. Measured with the stub-and-sink harness.

No configuration does this. `resourceNameTemplate` shapes the `resource.name` attribute,
not the name. The name is overridable per call, through `RequestInit.opentelemetry.spanName`,
which `supabase-js` does not set. `onStart` is the remaining hook, and renaming there is
safe in a way that rewriting in `onEnd` is not: exporters read the name at `onEnd`, so the
new name is already in place, and `onStart` receives a mutable `Span` by contract.

Two things this does not do:

- **`http.url` keeps the query string.** It is where the filters stay readable. An
  attribute costs storage, not span-name cardinality — but it is still exported, so the
  [PII](./platform-limits.md#pii) point stands unchanged.
- **Paths are only bounded because they are PostgREST.** `/rest/v1/items`,
  `/rest/v1/rpc/<fn>`. Fetching an API that puts ids in the path would need those
  segments collapsed too.

`spanProcessors: ['auto', …]` is additive: `'auto'` keeps the processors `@vercel/otel`
installs by default, and `traceExporter` is wrapped and appended independently of it.

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
[`registerOTel` alone is not enough](./setup.md#registerotel-alone-is-not-enough) describes.

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
[Outbound trace context](./trace-propagation.md#outbound-trace-context). Not worth consistent attribute names.

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
