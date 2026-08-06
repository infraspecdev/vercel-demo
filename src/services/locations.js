import { getSupabase, unwrap } from '../supabase.js'

export async function listLocations() {
  return unwrap(
    await getSupabase()
      .from('locations')
      .select('id, code, name, kind')
      .order('code')
  )
}

export async function getLocationByCode(code) {
  const rows = unwrap(
    await getSupabase()
      .from('locations')
      .select('id, code, name, kind')
      .eq('code', code)
      .limit(1)
  )

  if (rows.length === 0) {
    throw Object.assign(new Error(`No location with code ${code}`), { status: 404 })
  }

  return rows[0]
}
