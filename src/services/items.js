import { getSupabase, unwrap, MAX_ROWS } from '../supabase.js'

const ITEM_COLUMNS = 'id, sku, name, category, unit, reorder_level, unit_cost, supplier_id'

export async function listItems({ category, q, limit = 50 } = {}) {
  let query = getSupabase().from('items').select(ITEM_COLUMNS).order('sku').limit(limit)

  if (category) query = query.eq('category', category)
  if (q) query = query.ilike('name', `%${q}%`)

  return unwrap(await query)
}

export async function getItem(id) {
  const rows = unwrap(
    await getSupabase().from('items').select(ITEM_COLUMNS).eq('id', id).limit(1)
  )

  if (rows.length === 0) {
    throw Object.assign(new Error(`No item with id ${id}`), { status: 404 })
  }

  return rows[0]
}

export async function getItemsByIds(ids) {
  if (ids.length === 0) return []

  return unwrap(
    await getSupabase()
      .from('items')
      .select(ITEM_COLUMNS)
      .in('id', ids)
      .range(0, MAX_ROWS - 1)
  )
}

export async function listAllItems() {
  return unwrap(
    await getSupabase().from('items').select(ITEM_COLUMNS).range(0, MAX_ROWS - 1)
  )
}

/**
 * PostgREST has no DISTINCT, and there are only 240 items, so the categories are
 * cheaper to derive here than to model as a view.
 */
export async function listCategories() {
  const rows = unwrap(await getSupabase().from('items').select('category').range(0, MAX_ROWS - 1))
  return [...new Set(rows.map((row) => row.category))].sort()
}
