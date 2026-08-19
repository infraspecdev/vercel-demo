// OpenTelemetry setup. Imported first by both entrypoints, before anything it
// instruments.
//
// Telemetry is opt-in: with OTEL_EXPORTER_OTLP_ENDPOINT unset, registerOTel is
// never called and the app behaves exactly as it did before this file existed.
//
// Nothing here is arbitrary, and several of the choices look wrong until you know
// why. All of them are measured and explained under docs/opentelemetry/:
//
//   'auto' + HttpInstrumentation   setup.md
//   no instrumentation-express     setup.md
//   no attributesFromHeaders       setup.md
//   no outbound trace context      trace-propagation.md (the fix lives in src/supabase.js)
//   spanProcessors: ['auto', …]    span-conventions.md
//   BatchLogRecordProcessor({ })   library-gotchas.md
//   DELTA metric temporality       README.md, Business metrics
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

import { fetchSpanNames } from './src/telemetry/fetchSpanNames.js'

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/$/, '')

export const telemetryEnabled = Boolean(endpoint)

if (telemetryEnabled) {
  const headers = process.env.OTEL_AUTH_TOKEN
    ? { Authorization: `Bearer ${process.env.OTEL_AUTH_TOKEN}` }
    : {}

  registerOTel({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'inventory-service',

    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers }),

    // 'auto' keeps the processors @vercel/otel installs by default; the exporter
    // above is added alongside them either way. fetchSpanNames only renames.
    spanProcessors: ['auto', fetchSpanNames],

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
