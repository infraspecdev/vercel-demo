import { trace, SpanStatusCode } from '@opentelemetry/api'

const tracer = trace.getTracer('inventory-service')

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
 * The span also records exceptions and sets an error status, so a failed query is
 * visible as a red span rather than only as an HTTP 500.
 */
export function withSpan(name, attributes, fn) {
  return tracer.startActiveSpan(name, { attributes: defined(attributes) }, async (span) => {
    try {
      return await fn(span)
    } catch (error) {
      span.recordException(error)
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
      throw error
    } finally {
      span.end()
    }
  })
}
