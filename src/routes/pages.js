import { Router } from 'express'

import { listLocations, getLocationByCode } from '../services/locations.js'
import { listItems, getItem, listCategories } from '../services/items.js'
import { stockByItem, stockByLocation, lowStock } from '../services/stock.js'
import { listMovements, recordMovement, MOVEMENT_KINDS } from '../services/movements.js'
import { layout, table, esc } from '../views/layout.js'
import { requireInt, optionalInt, boundedLimit, requireOneOf, badRequest } from '../validate.js'

const router = Router()

const qty = (n) => esc(n)
const when = (iso) => esc(new Date(iso).toISOString().replace('T', ' ').slice(0, 16))

router.get('/', async (_req, res) => {
  // Sequential rather than Promise.all: the dashboard is the page used to
  // demonstrate tracing, and serial calls make the waterfall readable.
  const locations = await listLocations()
  const low = await lowStock({ limit: 12 })
  const recent = await listMovements({ limit: 8 })

  const cards = [
    ['Locations', locations.length],
    ['Low stock alerts', low.length === 12 ? '12+' : low.length],
    ['Recent movements', recent.length]
  ]
    .map(([k, n]) => `<div class="card"><div class="n">${esc(n)}</div><div class="k">${esc(k)}</div></div>`)
    .join('')

  const body = `
    <h1>Dashboard</h1>
    <p class="sub">Stock levels and ledger activity across warehouses, stores and outlets.</p>
    <div class="cards">${cards}</div>

    <h2>Below reorder level</h2>
    ${table({
      columns: [
        { label: 'SKU', cell: (r) => `<a href="/items/${r.item_id}"><code>${esc(r.sku)}</code></a>` },
        { label: 'Item', cell: (r) => esc(r.name) },
        { label: 'Location', cell: (r) => `<a href="/locations/${encodeURIComponent(r.location_code)}">${esc(r.location_name)}</a>` },
        { label: 'On hand', num: true, cell: (r) => `<span class="low">${esc(r.quantity)}</span>` },
        { label: 'Reorder at', num: true, cell: (r) => qty(r.reorder_level) },
        { label: 'Short by', num: true, cell: (r) => qty(r.shortfall) }
      ],
      rows: low,
      empty: 'Every location is above its reorder level.'
    })}

    <h2>Latest movements</h2>
    ${table({
      columns: [
        { label: 'When', cell: (r) => when(r.created_at) },
        { label: 'Kind', cell: (r) => `<span class="tag">${esc(r.kind)}</span>` },
        { label: 'Item', cell: (r) => `<a href="/items/${r.item_id}">${esc(r.items?.name ?? r.item_id)}</a>` },
        { label: 'Location', cell: (r) => esc(r.locations?.name ?? r.location_id) },
        { label: 'Qty', num: true, cell: (r) => qty(r.quantity) }
      ],
      rows: recent
    })}
  `

  res.type('html').send(layout({ title: 'Dashboard', current: '/', body }))
})

router.get('/items', async (req, res) => {
  const limit = boundedLimit(req.query.limit, { fallback: 50, max: 240 })
  const selected = req.query.category ?? ''
  const search = req.query.q ?? ''

  const categories = await listCategories()
  const items = await listItems({ category: selected || undefined, q: search || undefined, limit })

  const options = ['', ...categories]
    .map(
      (category) =>
        `<option value="${esc(category)}"${category === selected ? ' selected' : ''}>${
          category ? esc(category) : 'All categories'
        }</option>`
    )
    .join('')

  const body = `
    <h1>Items</h1>
    <p class="sub">${esc(items.length)} shown${selected ? ` in ${esc(selected)}` : ''}.</p>

    <form class="filters" method="get" action="/items">
      <label>Category<select name="category">${options}</select></label>
      <label>Search<input name="q" value="${esc(search)}" placeholder="e.g. bracket"></label>
      <button type="submit">Filter</button>
    </form>

    ${table({
      columns: [
        { label: 'SKU', cell: (r) => `<a href="/items/${r.id}"><code>${esc(r.sku)}</code></a>` },
        { label: 'Name', cell: (r) => esc(r.name) },
        { label: 'Category', cell: (r) => `<span class="tag">${esc(r.category)}</span>` },
        { label: 'Unit', cell: (r) => esc(r.unit) },
        { label: 'Reorder at', num: true, cell: (r) => qty(r.reorder_level) },
        { label: 'Unit cost', num: true, cell: (r) => esc(Number(r.unit_cost).toFixed(2)) }
      ],
      rows: items,
      empty: 'No items match those filters.'
    })}
  `

  res.type('html').send(layout({ title: 'Items', current: '/items', body }))
})

router.get('/items/:id', async (req, res) => {
  const id = requireInt(req.params.id, 'id')
  const item = await getItem(id)
  const stock = await stockByItem(id)
  const movements = await listMovements({ itemId: id, limit: 20 })
  const total = stock.reduce((sum, row) => sum + row.quantity, 0)

  const body = `
    <h1>${esc(item.name)}</h1>
    <p class="sub"><code>${esc(item.sku)}</code> · <span class="tag">${esc(item.category)}</span>
       · per ${esc(item.unit)} · reorder at ${esc(item.reorder_level)}</p>

    <div class="cards">
      <div class="card"><div class="n">${esc(total)}</div><div class="k">Total on hand</div></div>
      <div class="card"><div class="n">${esc(stock.length)}</div><div class="k">Locations stocked</div></div>
      <div class="card"><div class="n">${esc(Number(item.unit_cost).toFixed(2))}</div><div class="k">Unit cost</div></div>
    </div>

    <h2>Stock by location</h2>
    ${table({
      columns: [
        {
          label: 'Location',
          cell: (r) =>
            `<a href="/locations/${encodeURIComponent(r.locations?.code ?? '')}">${esc(
              r.locations?.name ?? r.location_id
            )}</a>`
        },
        { label: 'Kind', cell: (r) => `<span class="tag">${esc(r.locations?.kind ?? '')}</span>` },
        {
          label: 'On hand',
          num: true,
          cell: (r) =>
            r.quantity < item.reorder_level
              ? `<span class="low">${esc(r.quantity)}</span>`
              : qty(r.quantity)
        },
        { label: 'Updated', cell: (r) => when(r.updated_at) }
      ],
      rows: stock
    })}

    <h2>Movement history</h2>
    ${table({
      columns: [
        { label: 'When', cell: (r) => when(r.created_at) },
        { label: 'Kind', cell: (r) => `<span class="tag">${esc(r.kind)}</span>` },
        { label: 'Location', cell: (r) => esc(r.locations?.name ?? r.location_id) },
        { label: 'Qty', num: true, cell: (r) => qty(r.quantity) },
        { label: 'Reference', cell: (r) => `<code>${esc(r.reference ?? '')}</code>` }
      ],
      rows: movements,
      empty: 'No movements recorded for this item.'
    })}
  `

  res.type('html').send(layout({ title: item.name, current: '/items', body }))
})

router.get('/locations/:code', async (req, res) => {
  const location = await getLocationByCode(req.params.code)
  const stock = await stockByLocation(location.id, { limit: 200 })
  const movements = await listMovements({ locationId: location.id, limit: 20 })

  const body = `
    <h1>${esc(location.name)}</h1>
    <p class="sub"><code>${esc(location.code)}</code> · <span class="tag">${esc(location.kind)}</span></p>

    <h2>Stock held here</h2>
    ${table({
      columns: [
        { label: 'SKU', cell: (r) => `<a href="/items/${r.item_id}"><code>${esc(r.items?.sku ?? '')}</code></a>` },
        { label: 'Item', cell: (r) => esc(r.items?.name ?? r.item_id) },
        { label: 'Category', cell: (r) => `<span class="tag">${esc(r.items?.category ?? '')}</span>` },
        {
          label: 'On hand',
          num: true,
          cell: (r) =>
            r.items && r.quantity < r.items.reorder_level
              ? `<span class="low">${esc(r.quantity)}</span>`
              : qty(r.quantity)
        },
        { label: 'Reorder at', num: true, cell: (r) => qty(r.items?.reorder_level ?? '') }
      ],
      rows: stock
    })}

    <h2>Recent movements here</h2>
    ${table({
      columns: [
        { label: 'When', cell: (r) => when(r.created_at) },
        { label: 'Kind', cell: (r) => `<span class="tag">${esc(r.kind)}</span>` },
        { label: 'Item', cell: (r) => `<a href="/items/${r.item_id}">${esc(r.items?.name ?? r.item_id)}</a>` },
        { label: 'Qty', num: true, cell: (r) => qty(r.quantity) }
      ],
      rows: movements,
      empty: 'No movements recorded at this location.'
    })}
  `

  res.type('html').send(layout({ title: location.name, current: '/', body }))
})

router.get('/movements', async (req, res) => {
  const limit = boundedLimit(req.query.limit, { fallback: 40, max: 200 })
  const itemId = optionalInt(req.query.item_id, 'item_id', undefined)

  const movements = await listMovements({ itemId, limit })
  const locations = await listLocations()

  const notice = req.query.recorded
    ? `<div class="notice">Recorded movement #${esc(req.query.recorded)}.</div>`
    : req.query.error
      ? `<div class="notice">${esc(req.query.error)}</div>`
      : ''

  const locationOptions = locations
    .map((location) => `<option value="${location.id}">${esc(location.name)}</option>`)
    .join('')

  const kindOptions = MOVEMENT_KINDS.map((kind) => `<option value="${kind}">${kind}</option>`).join('')

  const body = `
    <h1>Movements</h1>
    <p class="sub">Append-only ledger. Recording a movement also updates the stock level.</p>
    ${notice}

    <form class="record" method="post" action="/movements">
      <label>Item ID<input name="item_id" type="number" min="1" max="240" value="1" required></label>
      <label>Location<select name="location_id">${locationOptions}</select></label>
      <label>Kind<select name="kind">${kindOptions}</select></label>
      <label>Quantity<input name="quantity" type="number" value="5" required></label>
      <label>Reference<input name="reference" placeholder="optional"></label>
      <button type="submit">Record</button>
    </form>

    <h2>Ledger</h2>
    ${table({
      columns: [
        { label: 'When', cell: (r) => when(r.created_at) },
        { label: 'Kind', cell: (r) => `<span class="tag">${esc(r.kind)}</span>` },
        { label: 'Item', cell: (r) => `<a href="/items/${r.item_id}">${esc(r.items?.name ?? r.item_id)}</a>` },
        { label: 'Location', cell: (r) => esc(r.locations?.name ?? r.location_id) },
        { label: 'Qty', num: true, cell: (r) => qty(r.quantity) },
        { label: 'Reference', cell: (r) => `<code>${esc(r.reference ?? '')}</code>` }
      ],
      rows: movements
    })}
  `

  res.type('html').send(layout({ title: 'Movements', current: '/movements', body }))
})

router.post('/movements', async (req, res) => {
  const body = req.body ?? {}

  try {
    const kind = requireOneOf(body.kind, MOVEMENT_KINDS, 'kind')
    const quantity = requireInt(body.quantity, 'quantity')

    if (kind !== 'adjustment' && quantity <= 0) {
      throw badRequest(`quantity must be positive for a ${kind}`)
    }

    const result = await recordMovement({
      itemId: requireInt(body.item_id, 'item_id'),
      locationId: requireInt(body.location_id, 'location_id'),
      kind,
      quantity,
      reference: body.reference || null
    })

    res.redirect(`/movements?recorded=${result.movement.id}`)
  } catch (error) {
    // The form posts back to itself, so a rejected movement is shown in place
    // rather than replacing the page with an error screen.
    res.redirect(`/movements?error=${encodeURIComponent(error.message)}`)
  }
})

export default router
