// Local entrypoint: a long-running server. Vercel uses api/index.js instead.
import { createApp } from './src/app.js'

const port = Number(process.env.PORT ?? 3000)

createApp().listen(port, () => {
  console.log(`Hospital inventory listening on http://localhost:${port}`)

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set — data routes will return 503.')
  }
})
