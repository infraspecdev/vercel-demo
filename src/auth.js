import { createHash, timingSafeEqual } from 'node:crypto'

import { trace } from '@opentelemetry/api'

const BEARER = /^Bearer\s+(\S.*)$/i

/**
 * Compares two secrets without leaking their contents through timing.
 *
 * `timingSafeEqual` requires buffers of equal length and throws otherwise, which
 * would turn the length of the key into an observable. Digesting both sides first
 * makes every comparison 32 bytes wide, so length never reaches the comparison.
 */
function equals(a, b) {
  const digest = (value) => createHash('sha256').update(value, 'utf8').digest()

  return timingSafeEqual(digest(a), digest(b))
}

function unauthorized(reason) {
  return Object.assign(new Error('Unauthorized'), { status: 401, authRejectedReason: reason })
}

/**
 * Requires a shared key on every request, sent as `Authorization: Bearer <key>`.
 *
 * Fails closed: with `API_KEY` unset nothing can match, so an unconfigured
 * deployment rejects every request rather than serving an open API.
 *
 * The reason is recorded on the span but never in the response — a caller learns
 * only that it was rejected, while SigNoz can still tell a client that forgot the
 * header apart from one guessing keys.
 */
export function requireApiKey(req, _res, next) {
  const reason = rejectionReason(req.headers.authorization)

  if (!reason) return next()

  trace.getActiveSpan()?.setAttribute('auth.rejected_reason', reason)
  throw unauthorized(reason)
}

function rejectionReason(header) {
  if (!header) return 'missing'

  const token = header.match(BEARER)?.[1]?.trim()
  if (!token) return 'malformed'

  const configured = process.env.API_KEY
  if (!configured || !equals(token, configured)) return 'mismatch'

  return null
}
