import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { startSupabaseStub } from './helpers/supabase-stub.js'
import { createApp } from '../src/app.js'
import { requireApiKey } from '../src/auth.js'

const KEY = 'test-api-key'

let base
let stub
let server

before(async () => {
  stub = await startSupabaseStub()
  process.env.API_KEY = KEY

  server = createApp().listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  await stub.close()
})

const get = (path, headers = {}) => fetch(base + path, { headers })

describe('the API key gate', () => {
  test('rejects a request that sends no Authorization header', async () => {
    const res = await get('/api/locations')

    assert.equal(res.status, 401)
    assert.deepEqual(await res.json(), { error: 'Unauthorized' })
  })

  test('rejects an Authorization scheme other than Bearer', async () => {
    const res = await get('/api/locations', { authorization: `Basic ${KEY}` })

    assert.equal(res.status, 401)
  })

  test('rejects a Bearer header carrying an empty token', async () => {
    const res = await get('/api/locations', { authorization: 'Bearer ' })

    assert.equal(res.status, 401)
  })

  test('rejects a token that is not the configured key', async () => {
    const res = await get('/api/locations', { authorization: 'Bearer wrong-key' })

    assert.equal(res.status, 401)
  })

  test('accepts the configured key and serves the route', async () => {
    const res = await get('/api/locations', { authorization: `Bearer ${KEY}` })

    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), {
      locations: [{ id: 1, code: 'WH-A', name: 'Warehouse A', kind: 'warehouse' }]
    })
  })

  test('rejects every token when no key is configured', async () => {
    delete process.env.API_KEY
    try {
      const res = await get('/api/locations', { authorization: `Bearer ${KEY}` })

      assert.equal(res.status, 401)
    } finally {
      process.env.API_KEY = KEY
    }
  })

  test('answers an unknown /api path with 401 rather than 404', async () => {
    const res = await get('/api/bogus')

    assert.equal(res.status, 401)
  })
})

describe('routes outside the gate', () => {
  test('serves /health without a key', async () => {
    const res = await get('/health')

    assert.equal(res.status, 200)
    assert.equal((await res.json()).status, 'ok')
  })

  test('serves the dashboard without a key', async () => {
    const res = await get('/')

    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /text\/html/)
  })

  test('serves an HTML item page without a key', async () => {
    const res = await get('/items')

    assert.equal(res.status, 200)
  })
})

describe('the reason a request was rejected', () => {
  // Recorded on the span so a forgotten header can be told apart from a wrong
  // key in SigNoz. Carried on the error, which is where the span reads it from.
  const reasonFor = (headers) => {
    const request = { headers }
    try {
      requireApiKey(request, {}, () => {})
    } catch (error) {
      return error.authRejectedReason
    }
    return undefined
  }

  test('is "missing" when there is no Authorization header', () => {
    assert.equal(reasonFor({}), 'missing')
  })

  test('is "malformed" when the header is not a Bearer token', () => {
    assert.equal(reasonFor({ authorization: `Basic ${KEY}` }), 'malformed')
  })

  test('is "malformed" when the Bearer token is empty', () => {
    assert.equal(reasonFor({ authorization: 'Bearer   ' }), 'malformed')
  })

  test('is "mismatch" when a well-formed token is simply wrong', () => {
    assert.equal(reasonFor({ authorization: 'Bearer wrong-key' }), 'mismatch')
  })

  test('does not reject the configured key', () => {
    assert.equal(reasonFor({ authorization: `Bearer ${KEY}` }), undefined)
  })
})
