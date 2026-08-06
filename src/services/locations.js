import { getSupabase, unwrap } from '../supabase.js'
import { withSpan } from '../telemetry/withSpan.js'

export async function listLocations() {
  return withSpan('inventory.locations.list', {}, async (span) => {
    const rows = unwrap(
      await getSupabase()
        .from('locations')
        .select('id, code, name, kind')
        .order('code')
    )

    span.setAttribute('inventory.result_count', rows.length)
    return rows
  })
}

export async function getLocationByCode(code) {
  return withSpan('inventory.locations.byCode', { 'inventory.location_code': code }, async () => {
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
  })
}
