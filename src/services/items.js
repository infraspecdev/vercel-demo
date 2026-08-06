import { getSupabase, unwrap, MAX_ROWS } from '../supabase.js'
import { withSpan } from '../telemetry/withSpan.js'

const ITEM_COLUMNS = 'id, sku, name, category, unit, reorder_level, unit_cost, supplier_id'

export async function listItems({ category, q, limit = 50 } = {}) {
  return withSpan(
    'inventory.items.list',
    { 'inventory.category': category, 'inventory.search': q, 'inventory.limit': limit },
    async (span) => {
      let query = getSupabase().from('items').select(ITEM_COLUMNS).order('sku').limit(limit)

      if (category) query = query.eq('category', category)
      if (q) query = query.ilike('name', `%${q}%`)

      const rows = unwrap(await query)
      span.setAttribute('inventory.result_count', rows.length)
      return rows
    }
  )
}

export async function getItem(id) {
  return withSpan('inventory.items.byId', { 'inventory.item_id': id }, async () => {
    const rows = unwrap(
      await getSupabase().from('items').select(ITEM_COLUMNS).eq('id', id).limit(1)
    )

    if (rows.length === 0) {
      throw Object.assign(new Error(`No item with id ${id}`), { status: 404 })
    }

    return rows[0]
  })
}

export async function getItemsByIds(ids) {
  if (ids.length === 0) return []

  return withSpan('inventory.items.byIds', { 'inventory.item_count': ids.length }, async () =>
    unwrap(
      await getSupabase()
        .from('items')
        .select(ITEM_COLUMNS)
        .in('id', ids)
        .range(0, MAX_ROWS - 1)
    )
  )
}

export async function listAllItems() {
  return withSpan('inventory.items.all', {}, async (span) => {
    const rows = unwrap(
      await getSupabase().from('items').select(ITEM_COLUMNS).range(0, MAX_ROWS - 1)
    )

    span.setAttribute('inventory.result_count', rows.length)
    return rows
  })
}

/**
 * PostgREST has no DISTINCT, and there are only 240 items, so the categories are
 * cheaper to derive here than to model as a view.
 */
export async function listCategories() {
  return withSpan('inventory.items.categories', {}, async (span) => {
    const rows = unwrap(
      await getSupabase().from('items').select('category').range(0, MAX_ROWS - 1)
    )

    const categories = [...new Set(rows.map((row) => row.category))].sort()
    span.setAttribute('inventory.result_count', categories.length)
    return categories
  })
}
