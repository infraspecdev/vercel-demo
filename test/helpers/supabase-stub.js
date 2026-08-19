import http from 'node:http'

/**
 * A stand-in for Supabase's PostgREST endpoint.
 *
 * The auth gate has to be exercised through the real app — mounting it on a
 * throwaway Express app would prove the middleware works but not that it is
 * wired in front of the right routes. Reaching the real routes means reaching
 * Supabase, so this answers in its place.
 *
 * Tables other than `locations` return an empty array, which is enough for the
 * pages under test to render.
 */
const ROWS = {
  locations: [{ id: 1, code: 'WH-A', name: 'Warehouse A', kind: 'warehouse' }]
}

export async function startSupabaseStub() {
  const server = http.createServer((req, res) => {
    const table = req.url.replace('/rest/v1/', '').split('?')[0]

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(ROWS[table] ?? []))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  const url = `http://127.0.0.1:${server.address().port}`

  // supabase.js caches its client on first use, so these must be set before the
  // app handles a request — not before each test.
  process.env.SUPABASE_URL = url
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-role-key'

  return { url, close: () => new Promise((resolve) => server.close(resolve)) }
}
