import { getSupabase, unwrap } from '../supabase.js'
import { getStockRow, setStockQuantity } from './stock.js'

export const MOVEMENT_KINDS = ['receipt', 'issue', 'transfer', 'adjustment']

const MOVEMENT_COLUMNS =
  'id, item_id, location_id, kind, quantity, reference, created_at, items(sku, name, unit), locations(code, name)'

export async function listMovements({ itemId, locationId, limit = 50 } = {}) {
  let query = getSupabase()
    .from('movements')
    .select(MOVEMENT_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (itemId) query = query.eq('item_id', itemId)
  if (locationId) query = query.eq('location_id', locationId)

  return unwrap(await query)
}

/**
 * How a movement kind changes the quantity held at a location.
 *
 * `transfer` decrements only. The schema gives a movement a single location, so a
 * real transfer is two rows — one out of the source, one into the destination.
 * Modelling that properly needs a transaction, which is out of scope here.
 */
function deltaFor(kind, quantity) {
  switch (kind) {
    case 'receipt':
      return quantity
    case 'issue':
    case 'transfer':
      return -quantity
    case 'adjustment':
      // Adjustments are signed by the caller: a stock count can go either way.
      return quantity
    default:
      throw Object.assign(new Error(`Unknown movement kind: ${kind}`), { status: 400 })
  }
}

/**
 * Records a movement and applies it to the stock level.
 *
 * THIS IS NOT ATOMIC, and that is deliberate — it makes the write visible as
 * multiple spans once tracing is added. Three round trips: read the current
 * quantity, append the ledger row, then write the new quantity. A crash between
 * the second and third leaves `stock` disagreeing with `movements`.
 *
 * In production this belongs in a single Postgres function invoked over RPC, so
 * the ledger row and the stock update commit or fail together. See the README.
 */
export async function recordMovement({ itemId, locationId, kind, quantity, reference }) {
  const current = await getStockRow(itemId, locationId)

  if (!current) {
    throw Object.assign(
      new Error(`No stock row for item ${itemId} at location ${locationId}`),
      { status: 404 }
    )
  }

  const delta = deltaFor(kind, quantity)
  const nextQuantity = current.quantity + delta

  if (nextQuantity < 0) {
    throw Object.assign(
      new Error(
        `Cannot ${kind} ${quantity}: only ${current.quantity} in stock at location ${locationId}`
      ),
      { status: 409 }
    )
  }

  const inserted = unwrap(
    await getSupabase()
      .from('movements')
      .insert({
        item_id: itemId,
        location_id: locationId,
        kind,
        quantity,
        reference: reference ?? null
      })
      .select('id, item_id, location_id, kind, quantity, reference, created_at')
  )

  const [stockRow] = await setStockQuantity(itemId, locationId, nextQuantity)

  return {
    movement: inserted[0],
    stock: stockRow,
    previous_quantity: current.quantity
  }
}
