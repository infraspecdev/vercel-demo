// Local entrypoint: a long-running server. Vercel uses api/index.js instead.
//
// Instrumentation must be evaluated before anything it instruments. ESM
// evaluates imports in order, so keeping this first is sufficient.
import { telemetryEnabled } from './instrumentation.js'

import { createApp } from './src/app.js'

const port = Number(process.env.PORT ?? 3000)

createApp().listen(port, () => {
  console.log(`Inventory service listening on http://localhost:${port}`)

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set — data routes will return 503.')
  }

  console.log(
    telemetryEnabled
      ? `Telemetry exporting to ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}`
      : 'Telemetry disabled — set OTEL_EXPORTER_OTLP_ENDPOINT to enable it.'
  )
})
