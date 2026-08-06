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
    auth: { persistSession: false, autoRefreshToken: false }
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
