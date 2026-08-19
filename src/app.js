import express from 'express'
import { trace } from '@opentelemetry/api'

import apiRoutes from './routes/api.js'
import pageRoutes from './routes/pages.js'
import { layout, esc } from './views/layout.js'
import { platformContext } from './telemetry/platformContext.js'
import { logger } from './telemetry/logger.js'
import { requireApiKey } from './auth.js'

/**
 * Records where a router is mounted, while that information is still available.
 *
 * `req.baseUrl` is only correct *inside* the router. When a handler throws, Express
 * unwinds back to the app before the response finishes and resets `req.baseUrl` to
 * `''` — so reading it later turns `/api/movements` into `/movements`, and every
 * error response gets filed under the wrong route.
 */
function recordMount(req, _res, next) {
  req.mountPath = req.baseUrl
  next()
}

/**
 * Names the request span after the matched Express route.
 *
 * HTTP instrumentation creates the span before routing has happened, so it can
 * only call it `GET`. The route is known once the response is finishing, and
 * renaming it there is what makes /items/1 and /items/2 aggregate as
 * /items/:id instead of becoming thousands of distinct span names.
 *
 * No-op when telemetry is disabled: getActiveSpan returns a non-recording span.
 */
function nameSpanAfterRoute(req, res, next) {
  const span = trace.getActiveSpan()

  res.on('finish', () => {
    if (!span || !req.route) return

    const route = `${req.mountPath ?? req.baseUrl}${req.route.path}`
    span.updateName(`${req.method} ${route}`)
    span.setAttribute('http.route', route)
  })

  next()
}

export function createApp() {
  const app = express()

  app.disable('x-powered-by')
  app.use(platformContext)
  app.use(nameSpanAfterRoute)
  app.use(express.json())
  app.use(express.urlencoded({ extended: false }))

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      supabase_configured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
    })
  })

  app.use('/api', recordMount, requireApiKey, apiRoutes)
  app.use('/', recordMount, pageRoutes)

  app.use((req, res) => {
    res.status(404)
    if (req.path.startsWith('/api/')) return res.json({ error: 'Not found', path: req.path })
    res.type('html').send(
      layout({
        title: 'Not found',
        current: '',
        body: `<h1>Not found</h1><p class="sub"><code>${esc(req.path)}</code> does not exist.</p>`
      })
    )
  })

  // Express 5 forwards rejected promises from async handlers here automatically,
  // so services can simply throw.
  app.use((error, req, res, _next) => {
    const status = error.status ?? 500

    // Logged at every status, not only 5xx: a burst of 409s is an operational signal
    // too. The severity distinguishes them — warn for a rejected request, error for a
    // fault — so the error rate stays a measure of faults.
    const log = status >= 500 ? logger.error : logger.warn

    log(`${req.method} ${req.path} failed`, {
      'http.request.method': req.method,
      'url.path': req.path,
      'http.response.status_code': status,
      'error.message': error.message,
      ...(error.supabaseCode ? { 'error.supabase_code': error.supabaseCode } : {})
    })

    if (req.path.startsWith('/api/')) {
      return res.status(status).json({
        error: error.message,
        ...(error.supabaseCode ? { supabase_code: error.supabaseCode } : {})
      })
    }

    res.status(status).type('html').send(
      layout({
        title: 'Error',
        current: '',
        body: `<h1>Something went wrong</h1>
               <div class="notice">${esc(error.message)}</div>
               <p class="sub">Status ${esc(status)}.</p>`
      })
    )
  })

  return app
}
