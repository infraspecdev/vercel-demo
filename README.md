# Hospital Inventory

A small Node.js service that manages hospital inventory — items, stock levels per
location, and an append-only movement ledger. Express on Vercel, Supabase for data.

It exists to be instrumented. See [Telemetry](#telemetry) — two files and about thirty
lines produce full request traces.

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
| `GET` | `/api/locations` | Wards, theatres, pharmacy, store |
| `GET` | `/api/items` | `?category=` `?q=` `?limit=` (max 240) |
| `GET` | `/api/items/:id` | Item, stock across all locations, and the total |
| `GET` | `/api/stock` | `?location=WARD-A` — required. `?limit=` (max 240) |
| `GET` | `/api/reports/low-stock` | Item/location pairs below reorder level |
| `GET` | `/api/movements` | `?item_id=` `?location_id=` `?limit=` (max 200) |
| `POST` | `/api/movements` | Records a movement and applies it to stock |

Recording a movement:

```bash
curl -X POST localhost:3000/api/movements \
  -H 'content-type: application/json' \
  -d '{"item_id":7,"location_id":1,"kind":"issue","quantity":5,"reference":"WARD-A-0412"}'
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
| `/locations/:code` | Everything held at one location, e.g. `/locations/WARD-A` |
| `/movements` | The ledger, plus a form for recording a movement |

## Two things done deliberately

### `POST /api/movements` is not atomic

Recording a movement is three round trips: read the current quantity, append the ledger
row, write the new quantity. A crash between the second and third leaves `stock`
disagreeing with `movements`.

This is kept because it makes the write legible once tracing is added — the sequence shows
up as distinct spans, and the risk becomes something you can see rather than something you
have to be told.

**It is not a production pattern.** In production this belongs in a single Postgres
function invoked over RPC, so the ledger row and the stock update commit or fail together.

### Low stock is measured per location, not per item

"Ward A is low on 10ml syringes" is the operational signal. A hospital-wide total hides
it, because stock sitting in Central Store does not help Ward A tonight.

`/api/reports/low-stock` therefore reads the stock table, the item catalogue, and the
locations, then compares in application code — three round trips and the slowest endpoint
in the app. That is on purpose too: it is the request where a trace tells you something a
log line cannot.

## Telemetry

OpenTelemetry traces exported over OTLP to SigNoz. Two files, about thirty lines, and no
changes to any service or route.

### Configuration

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.<region>.signoz.cloud:443
SIGNOZ_INGESTION_KEY=<key>
OTEL_SERVICE_NAME=hospital-inventory
```

Self-hosted SigNoz uses `http://localhost:4318` and needs no ingestion key.

**Telemetry is opt-in.** With `OTEL_EXPORTER_OTLP_ENDPOINT` unset, the SDK is never
registered and the app behaves exactly as it did before instrumentation existed.

### What a trace looks like

```
GET /api/reports/low-stock                 83.5ms  http.route=/api/reports/low-stock
└─ inventory.stock.lowStock                74.9ms  stock_rows_scanned=1920 low_stock_count=174
   ├─ fetch GET  .../rest/v1/stock         39.1ms
   ├─ fetch GET  .../rest/v1/items          6.2ms
   └─ fetch GET  .../rest/v1/locations      1.4ms

POST /api/movements                        47.5ms  http.route=/api/movements
└─ inventory.movements.record              25.2ms  movement_kind=issue quantity_delta=-3
   ├─ inventory.stock.read                 15.8ms  quantity_before=110
   │  └─ fetch GET   .../rest/v1/stock     14.1ms
   ├─ fetch POST  .../rest/v1/movements     5.1ms
   └─ inventory.stock.write                 2.6ms  quantity_after=107
      └─ fetch PATCH .../rest/v1/stock      1.9ms
```

The second one is the non-atomic write, visible rather than described.

### How little of this is hand-written

Almost none of it.

**`supabase-js` calls appear on their own.** It uses `fetch`, and `@vercel/otel`
instruments `fetch` by default. No wrappers around the data layer, no spans in
`src/services/`.

**`HttpInstrumentation` creates the request span** the Supabase spans hang from, and
extracts inbound `traceparent` so a request from an already-traced caller joins the same
trace. It patches `node:http`, a Node builtin, which is why it works under ESM with no
loader flag.

**Ten lines in `src/app.js` rename that span** after the matched route. HTTP
instrumentation runs before routing, so it can only call the span `GET`; renaming on
response finish is what makes `/items/1` and `/items/2` aggregate as `/items/:id`.

Deployment environment, region, git commit SHA, and deployment id come from `@vercel/otel`
automatically, derived from Vercel's system environment variables.

### Custom instrumentation: the part that has to be hand-written

Auto-instrumentation reports *that* a Supabase call happened and how long it took. It
cannot know what the application was doing, or with which item and location. That is what
`src/telemetry/withSpan.js` adds — one helper, used only in `src/services/`.

```js
export async function recordMovement({ itemId, locationId, kind, quantity }) {
  return withSpan(
    'inventory.movements.record',
    { 'inventory.item_id': itemId, 'inventory.movement_kind': kind },
    async (span) => { /* ... */ }
  )
}
```

The service layer is the only place Supabase is called, so wrapping that one layer covers
every route and page.

**Attributes worth querying**

| Attribute | On |
| --- | --- |
| `inventory.item_id`, `inventory.location_id`, `inventory.location_code` | most operations |
| `inventory.movement_kind`, `inventory.quantity`, `inventory.quantity_delta` | recording a movement |
| `inventory.quantity_before`, `inventory.quantity_after` | stock reads and writes |
| `inventory.low_stock_count`, `inventory.stock_rows_scanned` | the low-stock report |
| `inventory.result_count` | every list operation |

These turn traces into questions a hospital would actually ask. *"Every trace where
`inventory.movement_kind = issue` took over 500ms"* is not answerable from a URL and a
duration.

`inventory.stock_rows_scanned` alongside `inventory.low_stock_count` is the pair that
distinguishes "this report is slow because there is a lot to report" from "this report is
slow because it scans everything either way".

**Errors and business outcomes are recorded differently.** `withSpan` calls
`recordException` and sets an error status when a query fails. A movement rejected for
insufficient stock is *not* an error — it is a span event, `movement.rejected`, carrying
what was requested and what was available. Queryable, without polluting the error rate.

### Why not `instrumentation-express`

It would add route and middleware spans with no code at all. It patches a userland
package, which under ESM needs `--experimental-loader` at process start — and Vercel
provides no way to pass Node flags to the function runtime. It cannot be registered from
inside `instrumentation.js` either, because ESM loads the whole module graph before any
module body runs, so Express is already resolved by then.

Ten lines of renaming buys the same span name without the constraint.

### Vercel's own observability

Everything below works on the Hobby plan, alongside the SigNoz export:

- **Observability tab** — error rate, invocations, duration per route, plus an External
  APIs section where the Supabase calls appear.
- **Session Tracing** — start from the Vercel toolbar. 1M spans/month/team on every plan.
  Shows Vercel's infrastructure spans as well as these.
- **`vercel curl --trace /api/reports/low-stock`**, then `vercel traces get <id> --open`.

| | Vercel | SigNoz |
| --- | --- | --- |
| Infrastructure spans (CDN, routing, cold start) | ✅ | ❌ |
| Application and Supabase spans | ✅ | ✅ |
| Coverage | opt-in session | every request |
| Log retention | **1 hour** on Hobby | as configured |

**Vercel shows you now. SigNoz shows you then.** An incident at 14:00 investigated at 16:00
is gone from Vercel Hobby; in SigNoz the trace is still there.

### What is not captured

- **Time before the code runs** — CDN routing, queueing, container boot. Vercel Trace
  Drains close this gap by forwarding infrastructure spans directly, but they need a **Pro
  or Enterprise** plan ($0.50 per drains volume unit).
- **Requests that never reach the function** — CDN cache hits, edge 404s. Close to zero
  here, since every route is dynamic and nothing is cached.
- **Cold starts.** `@vercel/otel` reports region and deployment, but not whether an
  instance was cold. A module-level flag plus `process.uptime()` on the first request would
  measure initialisation — though not the container boot before Node started, which stays
  invisible from inside.
- **Logs.** `console.log` output still goes to Vercel's runtime logs, which Hobby keeps for
  one hour. Shipping logs to SigNoz with `trace_id` correlation is a separate increment.

### Upgrading to Trace Drains later

1. Upgrade to Pro.
2. Add a Trace Drain pointing at the SigNoz OTLP endpoint.
3. Remove the exporter from `instrumentation.js`.

Step 3 is a subtraction — `registerOTel()` stays. Do not run both in steady state: spans
would arrive twice by different paths and appear duplicated.

## Not included

Authentication, RLS policies, and multi-tenancy are all absent. `purchase_orders` and
`purchase_order_lines` exist in the schema but have no endpoints — they are not needed for
what this service is demonstrating.
