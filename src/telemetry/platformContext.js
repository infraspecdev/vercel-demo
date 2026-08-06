import { trace } from '@opentelemetry/api'

// Module scope survives for the life of a warm function instance, so the first
// request to observe `false` is by definition the one that paid for the cold start.
let warm = false

/**
 * Records what the platform knows about this invocation but does not tell the
 * application: whether the instance was cold, and how long it took to initialise.
 *
 * `process.uptime()` on the first request through a fresh instance measures the
 * time from Node starting to the request arriving — module loading, the Supabase
 * client, the OTel SDK. It does NOT include container boot before Node started,
 * which is not observable from inside the function. `faas.init_duration_ms` is
 * therefore a floor, not the whole cold-start cost.
 *
 * The distinction still matters in practice: a slow request with
 * `faas.coldstart=true` is a different problem from a slow request without it,
 * and only one of them is worth optimising the query for.
 */
export function platformContext(req, _res, next) {
  const span = trace.getActiveSpan()

  if (span) {
    const coldStart = !warm
    span.setAttribute('faas.coldstart', coldStart)

    if (coldStart) {
      span.setAttribute('faas.init_duration_ms', Math.round(process.uptime() * 1000))
    }

    // Vercel's own request id, which is how a trace in SigNoz is matched to the same
    // request in Vercel's runtime logs. Only present when running on Vercel.
    const requestId = req.headers['x-vercel-id']
    if (requestId) span.setAttribute('vercel.request_id', requestId)
  }

  warm = true
  next()
}
