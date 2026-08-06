import express from 'express'
import { trace } from '@opentelemetry/api'

import apiRoutes from './routes/api.js'
import pageRoutes from './routes/pages.js'
import { layout, esc } from './views/layout.js'

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

    const route = `${req.baseUrl}${req.route.path}`
    span.updateName(`${req.method} ${route}`)
    span.setAttribute('http.route', route)
  })

  next()
}

export function createApp() {
  const app = express()

  app.disable('x-powered-by')
  app.use(nameSpanAfterRoute)
  app.use(express.json())
  app.use(express.urlencoded({ extended: false }))

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      supabase_configured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
    })
  })

  app.use('/api', apiRoutes)
  app.use('/', pageRoutes)

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

    if (status >= 500) console.error(`${req.method} ${req.path} failed:`, error)

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
