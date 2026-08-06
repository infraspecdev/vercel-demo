export function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 })
}

export function requireInt(value, field) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) {
    throw badRequest(`${field} must be an integer, got ${JSON.stringify(value)}`)
  }
  return parsed
}

export function optionalInt(value, field, fallback) {
  if (value === undefined || value === '') return fallback
  return requireInt(value, field)
}

export function boundedLimit(value, { fallback, max }) {
  const parsed = optionalInt(value, 'limit', fallback)
  if (parsed < 1) throw badRequest('limit must be at least 1')
  return Math.min(parsed, max)
}

export function requireOneOf(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw badRequest(`${field} must be one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`)
  }
  return value
}
