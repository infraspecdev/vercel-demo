/**
 * Names `@vercel/otel`'s outbound fetch spans after the URL path, not the whole URL.
 *
 * Its fetch instrumentation names client spans `${client} ${method} ${url}`, query
 * string and all. PostgREST puts `select`, `order`, `limit` and every filter there,
 * so `getItem(7)` and `getItem(9)` arrive as two distinct span names — and a
 * thousand item ids arrive as a thousand. That is the unbounded-cardinality mistake
 * docs/opentelemetry/span-conventions.md warns about, reaching the backend by default
 * rather than by anyone's edit.
 *
 * No configuration turns it off. `resourceNameTemplate` only shapes the
 * `resource.name` attribute, and the span name is overridable per call — through
 * `RequestInit.opentelemetry.spanName`, which supabase-js does not set. Renaming in
 * `onStart` is the remaining hook, and it is enough: exporters read the name in
 * `onEnd`, long after this has run.
 *
 * Paths are bounded because every outbound call here is PostgREST — `/rest/v1/items`,
 * `/rest/v1/rpc/<fn>`. A service calling an API that puts ids in the path would need
 * those segments collapsed too.
 *
 * The full URL stays on `http.url`, so the filters are still there to read. It is
 * an attribute rather than a name, so it costs storage, not cardinality.
 */
export const fetchSpanNames = {
  onStart(span) {
    // Set by @vercel/otel's fetch instrumentation and nothing else: 'fetch' for the
    // global fetch, 'http' for the node:http module. The request spans from
    // instrumentation-http carry neither, so they keep the name app.js gives them.
    const client = span.attributes['http.client.name']
    if (client !== 'fetch' && client !== 'http') return

    const method = span.attributes['http.method']
    const url = span.attributes['http.url']
    if (typeof method !== 'string' || typeof url !== 'string') return

    try {
      span.updateName(`${client} ${method} ${new URL(url).pathname}`)
    } catch {
      // Unparseable URL. The original name is worse than the new one but better
      // than none, so leave it.
    }
  },

  onEnd() {},
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve()
}
