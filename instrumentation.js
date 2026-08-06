// OpenTelemetry setup. Imported first by both entrypoints, before anything it
// instruments.
//
// Telemetry is opt-in: with OTEL_EXPORTER_OTLP_ENDPOINT unset, registerOTel is
// never called and the app behaves exactly as it did before this file existed.
// A forgotten environment variable degrades telemetry, never the service.
import { registerOTel } from '@vercel/otel'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/$/, '')

export const telemetryEnabled = Boolean(endpoint)

if (telemetryEnabled) {
  // SigNoz Cloud authenticates with its own header. Self-hosted SigNoz needs no
  // key, so an absent value is not an error.
  const headers = process.env.SIGNOZ_INGESTION_KEY
    ? { 'signoz-ingestion-key': process.env.SIGNOZ_INGESTION_KEY }
    : {}

  registerOTel({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'hospital-inventory',

    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers }),

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
