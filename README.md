# Hospital Inventory

A small Node.js service that manages hospital inventory — items, stock levels per
location, and an append-only movement ledger. Express on Vercel, Supabase for data.

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

Deployment runs from GitHub Actions (`.github/workflows/deploy.yml`), not from Vercel's Git
integration:

| Trigger | Result |
| --- | --- |
| Pull request | Preview deployment, URL posted as a PR comment |
| Push to `main` | Production deployment |

Every deployment builds in CI, uploads with `--prebuilt`, then smoke-tests `/health` before
the job passes.

### One-time setup

**1. Link the project** and read the ids it writes:

```bash
npx vercel link
cat .vercel/project.json    # orgId and projectId
```

**2. Create a token** at [vercel.com/account/tokens](https://vercel.com/account/tokens).

**3. Add three repository secrets** under Settings → Secrets and variables → Actions:

| Secret | Value |
| --- | --- |
| `VERCEL_TOKEN` | the token from step 2 |
| `VERCEL_ORG_ID` | `orgId` from `.vercel/project.json` |
| `VERCEL_PROJECT_ID` | `projectId` from `.vercel/project.json` |

**4. Set runtime environment variables in Vercel**, not in GitHub — `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, and the telemetry variables. `vercel pull` fetches them at
build time, and the function reads them at runtime.

`.vercel/` is gitignored; it holds a local link, not a secret worth committing.

### Why the Git integration is off

`vercel.json` sets `git.deploymentEnabled: false`. Without it, a push would be built twice —
once by Vercel's integration and once by this workflow — doubling build minutes and
producing two deployments per commit.

To go back to Vercel-managed deploys, delete the workflow and remove that flag.

### If the smoke test warns instead of passing

Vercel Deployment Protection returns `401` on preview URLs. The workflow reports this as a
warning rather than a failure, since it means the deployment succeeded but could not be
reached. Turn protection off for previews to make the check meaningful.

No build step, no framework preset — `vercel.json` rewrites every path to a single function.

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

## Not included

Authentication, RLS policies, and multi-tenancy are all absent. `purchase_orders` and
`purchase_order_lines` exist in the schema but have no endpoints — they are not needed for
what this service is demonstrating.
