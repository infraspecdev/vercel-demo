// OpenTelemetry setup. Imported first by both entrypoints, before anything it
// instruments.
//
// Telemetry is opt-in: with OTEL_EXPORTER_OTLP_ENDPOINT unset, registerOTel is
// never called and the app behaves exactly as it did before this file existed.
//
// Nothing here is arbitrary, and several of the choices look wrong until you know
// why. All of them are measured and explained in docs/opentelemetry-on-vercel.md:
//
//   'auto' + HttpInstrumentation   Does not work out of the box
//   BatchLogRecordProcessor({ })   Library gotchas
//   no instrumentation-express     Does not work out of the box
//   no attributesFromHeaders       Does not work out of the box
//   no outbound trace context      Outbound trace context (it lives in src/supabase.js)
//   DELTA metric temporality       README, Business metrics
import { registerOTel } from '@vercel/otel'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs'
import {
  OTLPMetricExporter,
  AggregationTemporalityPreference
} from '@opentelemetry/exporter-metrics-otlp-http'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/$/, '')

export const telemetryEnabled = Boolean(endpoint)

if (telemetryEnabled) {
  const headers = process.env.OTEL_AUTH_TOKEN
    ? { Authorization: `Bearer ${process.env.OTEL_AUTH_TOKEN}` }
    : {}

  registerOTel({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'inventory-service',

    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers }),

    logRecordProcessors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: `${endpoint}/v1/logs`, headers })
      })
    ],

    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: `${endpoint}/v1/metrics`,
          headers,
          temporalityPreference: AggregationTemporalityPreference.DELTA
        }),
        exportIntervalMillis: 10_000
      })
    ],

    instrumentations: ['auto', new HttpInstrumentation()]
  })
}
