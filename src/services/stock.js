import { getSupabase, unwrap, MAX_ROWS } from '../supabase.js'

export async function stockByItem(itemId) {
  return unwrap(
    await getSupabase()
      .from('stock')
      .select('item_id, location_id, quantity, updated_at, locations(code, name, kind)')
      .eq('item_id', itemId)
      .order('location_id')
  )
}

export async function stockByLocation(locationId, { limit = 200 } = {}) {
  return unwrap(
    await getSupabase()
      .from('stock')
      .select('item_id, location_id, quantity, updated_at, items(sku, name, category, unit, reorder_level)')
      .eq('location_id', locationId)
      .order('item_id')
      .limit(limit)
  )
}

export async function getStockRow(itemId, locationId) {
  const rows = unwrap(
    await getSupabase()
      .from('stock')
      .select('item_id, location_id, quantity')
      .eq('item_id', itemId)
      .eq('location_id', locationId)
      .limit(1)
  )

  return rows[0] ?? null
}

export async function setStockQuantity(itemId, locationId, quantity) {
  return unwrap(
    await getSupabase()
      .from('stock')
      .update({ quantity, updated_at: new Date().toISOString() })
      .eq('item_id', itemId)
      .eq('location_id', locationId)
      .select('item_id, location_id, quantity, updated_at')
  )
}

/**
 * Item/location pairs whose quantity has fallen below the item's reorder level.
 *
 * Compared per location rather than per item on purpose. Reordering happens for a
 * place — "Ward A is low on 10ml syringes" is the operational signal; a hospital-wide
 * total hides it, because stock sitting in Central Store does not help Ward A tonight.
 *
 * Deliberately three round trips rather than one embedded join: stock, then the item
 * catalogue, then locations, with the comparison happening here. It is the slowest
 * endpoint in the app by design — the one where a trace tells you something a log
 * line cannot.
 */
export async function lowStock({ limit = 50 } = {}) {
  const stockRows = unwrap(
    await getSupabase().from('stock').select('item_id, location_id, quantity').range(0, MAX_ROWS - 1)
  )

  const items = unwrap(
    await getSupabase()
      .from('items')
      .select('id, sku, name, category, unit, reorder_level')
      .range(0, MAX_ROWS - 1)
  )

  const locations = unwrap(
    await getSupabase().from('locations').select('id, code, name, kind').range(0, MAX_ROWS - 1)
  )

  const itemsById = new Map(items.map((item) => [item.id, item]))
  const locationsById = new Map(locations.map((location) => [location.id, location]))

  return stockRows
    .flatMap((row) => {
      const item = itemsById.get(row.item_id)
      const location = locationsById.get(row.location_id)
      if (!item || !location) return []
      if (row.quantity >= item.reorder_level) return []

      return [
        {
          item_id: item.id,
          sku: item.sku,
          name: item.name,
          category: item.category,
          unit: item.unit,
          reorder_level: item.reorder_level,
          location_id: location.id,
          location_code: location.code,
          location_name: location.name,
          quantity: row.quantity,
          shortfall: item.reorder_level - row.quantity
        }
      ]
    })
    .sort((a, b) => b.shortfall - a.shortfall)
    .slice(0, limit)
}

export async function countLowStock() {
  const rows = await lowStock({ limit: Number.MAX_SAFE_INTEGER })
  return rows.length
}
