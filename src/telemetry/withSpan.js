import { trace, SpanStatusCode } from '@opentelemetry/api'

const tracer = trace.getTracer('hospital-inventory')

/** OpenTelemetry warns on undefined attribute values, and services pass optional filters. */
function defined(attributes = {}) {
  return Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined))
}

/**
 * Runs `fn` inside a span carrying domain attributes.
 *
 * Auto-instrumentation already reports every Supabase call and how long it took.
 * This adds the part it cannot know: what the application was *doing*, and with
 * which items and locations.
 *
 * Used only in the service layer. Because every Supabase call is confined there,
 * wrapping that one layer covers every route and page.
 *
 * Only server faults are marked as span errors. A 404 for an unknown item, or a 409
 * for insufficient stock, is the system working correctly and telling the caller no —
 * marking those red would make the error rate a measure of how often users ask for
 * something unavailable, which is not what anyone wants to be paged about. They still
 * carry `app.error.status`, so they remain queryable.
 */
export function withSpan(name, attributes, fn) {
  return tracer.startActiveSpan(name, { attributes: defined(attributes) }, async (span) => {
    try {
      return await fn(span)
    } catch (error) {
      const status = error.status ?? 500
      span.setAttribute('app.error.status', status)

      if (status >= 500) {
        span.recordException(error)
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
      }

      throw error
    } finally {
      span.end()
    }
  })
}
