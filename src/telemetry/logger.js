import { logs, SeverityNumber } from '@opentelemetry/api-logs'
import { trace } from '@opentelemetry/api'

// With no logger provider registered, the logs API is a no-op, so this is safe to
// call whether or not telemetry is configured.
const otelLogger = logs.getLogger('hospital-inventory')

/**
 * Writes every line twice.
 *
 * - to stdout, where Vercel picks it up for its runtime logs. Hobby keeps those
 *   for one hour.
 * - as an OTel log record, which SigNoz keeps for as long as it is configured to.
 *
 * Both carry the same `trace_id`, so a line found in one can be followed into the
 * other, and from either into the trace.
 *
 * The SDK reads trace context from the active span when it exports the record. The
 * ids are added to the stdout copy explicitly, since nothing else would put them there.
 */
function emit(severityNumber, severityText, message, attributes = {}) {
  const spanContext = trace.getActiveSpan()?.spanContext()

  const line = { level: severityText.toLowerCase(), msg: message, ...attributes }
  if (spanContext) {
    line.trace_id = spanContext.traceId
    line.span_id = spanContext.spanId
  }

  const write = severityNumber >= SeverityNumber.ERROR ? console.error : console.log
  write(JSON.stringify(line))

  otelLogger.emit({ severityNumber, severityText, body: message, attributes })
}

export const logger = {
  info: (message, attributes) => emit(SeverityNumber.INFO, 'INFO', message, attributes),
  warn: (message, attributes) => emit(SeverityNumber.WARN, 'WARN', message, attributes),
  error: (message, attributes) => emit(SeverityNumber.ERROR, 'ERROR', message, attributes)
}
