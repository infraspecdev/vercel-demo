// OpenTelemetry setup. Imported first by both entrypoints, before anything it
// instruments.
//
// Telemetry is opt-in: with OTEL_EXPORTER_OTLP_ENDPOINT unset, registerOTel is
// never called and the app behaves exactly as it did before this file existed.
// A forgotten environment variable degrades telemetry, never the service.
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
  // The collector authenticates on a plain `otel-auth-token` header — no
  // `Authorization` scheme, the token is the whole value. A collector that
  // needs no auth is not an error, so an absent value just sends no header.
  const headers = process.env.OTEL_AUTH_TOKEN
    ? { 'otel-auth-token': process.env.OTEL_AUTH_TOKEN }
    : {}

  registerOTel({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'inventory-service',

    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers }),

    // Note the options object. As of @opentelemetry/sdk-logs 0.221 the processor
    // takes `{ exporter }`, not a positional exporter. The positional form
    // constructs without error and then silently drops every record.
    logRecordProcessors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: `${endpoint}/v1/logs`, headers })
      })
    ],

    // DELTA temporality is not optional here. Each function instance keeps its own
    // counter, and instances come and go. Under the default CUMULATIVE the backend
    // sees many independent running totals that restart at zero, and summing them
    // is wrong. DELTA reports "what happened since the last export", which merges
    // correctly across instances.
    //
    // The short interval is also deliberate: a frozen function exports nothing, so
    // anything still buffered when it freezes is late rather than lost.
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

    // "auto" keeps @vercel/otel's fetch instrumentation, which is what turns every
    // supabase-js call into a span. HttpInstrumentation adds the incoming request
    // span those spans hang from — without it they arrive as separate, parentless
    // traces, one per Supabase call.
    instrumentations: ['auto', new HttpInstrumentation()]
  })
}

// registerOTel accepts `attributesFromHeaders`, which looks like the right way to put
// `x-vercel-id` on the request span. It does not apply here: it decorates spans
// @vercel/otel creates itself, and the request span in this app comes from
// HttpInstrumentation. Measured — the attribute never appeared. src/telemetry
// reads the header directly instead.

// Not used here: @opentelemetry/instrumentation-express. It would add route and
// middleware spans with no code at all, but patching a userland package under ESM
// needs a loader flag at process start (`--experimental-loader`), and Vercel gives
// no way to pass Node flags to the function runtime. It cannot be registered from
// inside this file either: ESM loads the whole module graph before any module body
// runs, so Express is already resolved by the time this executes.
//
// src/app.js names the request span from the matched route instead — ten lines,
// no flags.
