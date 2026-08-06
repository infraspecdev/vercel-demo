import { Router } from 'express'

import { listLocations, getLocationByCode } from '../services/locations.js'
import { listItems, getItem } from '../services/items.js'
import { stockByItem, stockByLocation, lowStock } from '../services/stock.js'
import { listMovements, recordMovement, MOVEMENT_KINDS } from '../services/movements.js'
import { badRequest, requireInt, optionalInt, boundedLimit, requireOneOf } from '../validate.js'

const router = Router()

router.get('/locations', async (_req, res) => {
  res.json({ locations: await listLocations() })
})

router.get('/items', async (req, res) => {
  const limit = boundedLimit(req.query.limit, { fallback: 50, max: 240 })

  res.json({
    items: await listItems({
      category: req.query.category,
      q: req.query.q,
      limit
    })
  })
})

router.get('/items/:id', async (req, res) => {
  const id = requireInt(req.params.id, 'id')
  const item = await getItem(id)
  const stock = await stockByItem(id)

  res.json({
    item,
    stock,
    total_quantity: stock.reduce((sum, row) => sum + row.quantity, 0)
  })
})

router.get('/stock', async (req, res) => {
  const code = req.query.location
  if (!code) throw badRequest('location is required, e.g. /api/stock?location=WARD-A')

  const limit = boundedLimit(req.query.limit, { fallback: 100, max: 240 })
  const location = await getLocationByCode(code)

  res.json({
    location,
    stock: await stockByLocation(location.id, { limit })
  })
})

router.get('/reports/low-stock', async (req, res) => {
  const limit = boundedLimit(req.query.limit, { fallback: 50, max: 500 })
  const rows = await lowStock({ limit })

  res.json({ count: rows.length, limit, low_stock: rows })
})

router.get('/movements', async (req, res) => {
  const limit = boundedLimit(req.query.limit, { fallback: 50, max: 200 })

  res.json({
    movements: await listMovements({
      itemId: optionalInt(req.query.item_id, 'item_id', undefined),
      locationId: optionalInt(req.query.location_id, 'location_id', undefined),
      limit
    })
  })
})

router.post('/movements', async (req, res) => {
  const body = req.body ?? {}

  const itemId = requireInt(body.item_id, 'item_id')
  const locationId = requireInt(body.location_id, 'location_id')
  const kind = requireOneOf(body.kind, MOVEMENT_KINDS, 'kind')
  const quantity = requireInt(body.quantity, 'quantity')

  // Adjustments carry their own sign; every other kind states a magnitude and
  // lets the movement kind decide the direction.
  if (kind !== 'adjustment' && quantity <= 0) {
    throw badRequest(`quantity must be positive for a ${kind}, got ${quantity}`)
  }
  if (kind === 'adjustment' && quantity === 0) {
    throw badRequest('an adjustment of 0 changes nothing')
  }

  const result = await recordMovement({
    itemId,
    locationId,
    kind,
    quantity,
    reference: body.reference
  })

  res.status(201).json(result)
})

export default router
