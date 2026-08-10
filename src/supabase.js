// Registers the OpenTelemetry trace context extractor that `tracePropagation`
// below depends on. The import *is* the opt-in — the module has no exports.
//
// It lives here rather than in instrumentation.js on purpose. Setting
// `tracePropagation` without this import is not an error, just a one-time
// warning and silently missing headers, so the two belong in the same file
// where they cannot drift apart.
//
// Unconditional, not gated on OTEL_EXPORTER_OTLP_ENDPOINT: with no SDK
// registered the extractor injects through the no-op propagator, finds no
// traceparent, and returns null. No headers are added. Measured.
import '@supabase/supabase-js/tracing'
import { createClient } from '@supabase/supabase-js'

let client

/**
 * Lazily builds the Supabase client.
 *
 * Lazy rather than module-level so that importing a service does not throw when
 * credentials are absent — `/health` and the error pages still need to work.
 */
export function getSupabase() {
  if (client) return client

  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw Object.assign(
      new Error(
        'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see .env.example).'
      ),
      { status: 503 }
    )
  }

  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },

    // Sends W3C `traceparent` on every Supabase request, so the trace id in
    // SigNoz is the same one Supabase records in its API Gateway logs.
    //
    // @vercel/otel does not do this for us. Its fetch instrumentation
    // propagates context only to same-origin and Vercel deployment URLs;
    // supabase.co is neither. Measured.
    //
    // supabase-js restricts the header to *.supabase.co, *.supabase.in and
    // localhost, so a custom fetch to a third-party host is never tagged.
    //
    // `respectSamplingDecision` is left at its default of true. Nothing is
    // sampled out today, so it changes nothing — but adding a sampler later
    // would stop unsampled requests carrying a trace id into Supabase's logs.
    tracePropagation: true
  })

  return client
}

/**
 * supabase-js resolves rather than rejects on failure, returning `{ data, error }`.
 * Every service call goes through here so a Supabase failure becomes a thrown
 * error that Express's error handler can render.
 */
export function unwrap({ data, error }) {
  if (error) {
    throw Object.assign(new Error(`Supabase: ${error.message}`), {
      status: 502,
      supabaseCode: error.code,
      supabaseDetails: error.details
    })
  }
  return data
}

/**
 * PostgREST caps responses at 1000 rows by default. The stock table is
 * 240 items x 8 locations = 1920 rows, so reads that legitimately span the
 * whole table must ask for a wider range explicitly.
 */
export const MAX_ROWS = 5000
