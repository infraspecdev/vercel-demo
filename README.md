# Inventory Service

A small Node.js inventory service — items, stock levels per location, and an append-only
movement ledger. Express on Vercel, Supabase for data.

It exists to be instrumented. The application is deliberately ordinary so that adding
OpenTelemetry to it (a separate pull request) reads as a clear, reviewable change rather
than as noise.

## Getting started

### 1. Create the database

Open the Supabase SQL Editor and run [`schema.sql`](./schema.sql) once. It creates the
tables, indexes, and seed data: 8 locations, 240 items, stock for every item in every
location, and 5000 historical movements.

The script ends with a row count, which is a quick check it worked.

### 2. Configure

```bash
cp .env.example .env
```

Fill in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from your Supabase project
settings, under **Project Settings → API**.

> **The service role key bypasses Row Level Security.** `schema.sql` disables RLS
> deliberately (see the note at the top of that file), so this key is the only thing
> between the public internet and the entire dataset. It is read server-side only, and it
> must never reach a browser or a client bundle.

### 3. Run

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # same, with --watch
```

The app starts without Supabase credentials. `/health` reports `supabase_configured:
false` and every data route returns `503` with an explanation, rather than crashing.

## Deploying to Vercel

Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as Environment Variables in the Vercel
project, then push. No build step, no framework preset — `vercel.json` rewrites every path
to a single function.

## Layout

```
api/index.js       Vercel entrypoint — exports the Express app as a function
server.js          Local entrypoint — app.listen()
src/
  app.js           Express assembly, 404 and error handlers
  supabase.js      Client factory and error unwrapping
  services/        Data access. Every Supabase call lives here.
  routes/api.js    JSON endpoints
  routes/pages.js  Server-rendered HTML
  views/layout.js  Page shell, table helper, HTML escaping
  validate.js      Request parsing and validation
```

Two entrypoints, one app. Neither holds logic — both import `src/app.js`.

**`services/` is the only place Supabase is called.** That constraint is the point: it
gives instrumentation a single seam to wrap, so tracing every endpoint later means
touching one layer rather than every route handler.

There is no build step. HTML is assembled from template literals, and every interpolated
value is escaped.

## HTTP API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | Liveness, plus whether Supabase is configured |
| `GET` | `/api/locations` | Warehouses, stores, outlet, transit |
| `GET` | `/api/items` | `?category=` `?q=` `?limit=` (max 240) |
| `GET` | `/api/items/:id` | Item, stock across all locations, and the total |
| `GET` | `/api/stock` | `?location=WH-A` — required. `?limit=` (max 240) |
| `GET` | `/api/reports/low-stock` | Item/location pairs below reorder level |
| `GET` | `/api/movements` | `?item_id=` `?location_id=` `?limit=` (max 200) |
| `POST` | `/api/movements` | Records a movement and applies it to stock |

Recording a movement:

```bash
curl -X POST localhost:3000/api/movements \
  -H 'content-type: application/json' \
  -d '{"item_id":7,"location_id":1,"kind":"issue","quantity":5,"reference":"WH-A-0412"}'
```

`kind` is one of `receipt`, `issue`, `transfer`, `adjustment`. Receipts add; issues and
transfers subtract; adjustments are signed by the caller, so a stock count can correct in
either direction. Issuing more than is held returns `409`.

Errors are JSON with an `error` message and a meaningful status: `400` for bad input,
`404` for missing records, `409` for a movement that would drive stock negative, `503`
when Supabase is unconfigured, `502` when Supabase itself fails.

## Pages

| Path | Contents |
| --- | --- |
| `/` | Counts, items below reorder level, latest movements |
| `/items` | Item list with category filter and name search |
| `/items/:id` | Item detail, stock by location, movement history |
| `/locations/:code` | Everything held at one location, e.g. `/locations/WH-A` |
| `/movements` | The ledger, plus a form for recording a movement |

## Known limitations

`POST /api/movements` is not atomic. It reads the current quantity, appends the ledger row,
then writes the new quantity. A crash between the second and third leaves `stock`
disagreeing with `movements`. This belongs in a single Postgres function invoked over RPC.

`/api/reports/low-stock` compares in application code. It reads the stock table, the item
catalogue and the locations, then filters. This belongs in a SQL view.

Low stock is measured per location, not per item. "Store 1 is low on 10mm cable" is the
operational signal. A company-wide total hides it, because stock sitting in Warehouse A
does not help Store 1 today.

## Not included

Authentication, RLS policies, and multi-tenancy are all absent. `purchase_orders` and
`purchase_order_lines` exist in the schema but have no endpoints — they are not needed for
what this service is demonstrating.
