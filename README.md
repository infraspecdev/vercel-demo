# Inventory Service

A small Node.js inventory service — items, stock levels per location, and an append-only
movement ledger. Express on Vercel, Supabase for data.

It is instrumented with OpenTelemetry. See [Telemetry](#telemetry).

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
instrumentation.js   OpenTelemetry SDK setup. Imported first by both entrypoints.
api/index.js         Vercel entrypoint — exports the Express app as a function
server.js            Local entrypoint — app.listen()
src/
  app.js             Express assembly, 404 and error handlers
  supabase.js        Client factory and error unwrapping
  services/          Data access. Every Supabase call lives here.
  routes/api.js      JSON endpoints
  routes/pages.js    Server-rendered HTML
  views/layout.js    Page shell, table helper, HTML escaping
  validate.js        Request parsing and validation
  telemetry/
    withSpan.js         Wraps a service call in a span with domain attributes
    platformContext.js  Cold start and Vercel request id
    logger.js           Logs to stdout and to SigNoz, with trace ids
    metrics.js          Business counters
```

Two entrypoints, one app. Neither holds logic — both import `src/app.js`.

**`services/` is the only place Supabase is called.** That gives instrumentation a single
seam, so tracing every endpoint means touching one layer rather than every route handler.

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

## Telemetry

OpenTelemetry traces and logs, exported over OTLP to an OpenTelemetry Collector, which
processes the signals and forwards them to SigNoz. The app never talks to SigNoz directly.

Most of it costs nothing. `instrumentation.js` plus about ten lines in `src/app.js` produce
full request traces on their own. The rest — domain attributes, cold starts, log
correlation — is hand-written, and each piece is described below.

### Configuration

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://<collector-host>:4318
OTEL_AUTH_TOKEN=<token>
OTEL_SERVICE_NAME=inventory-service
```

`OTEL_AUTH_TOKEN` holds the bare token and is sent as `Authorization: Bearer <token>` on
every OTLP export — the `Bearer ` prefix is added in code, so the variable itself is a
plain credential. Leave it unset for a collector that needs no auth; no header is sent,
which is not an error.

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

The second is the non-atomic write. The three calls are visible as separate spans.

### What comes for free

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

**One caveat when querying.** The two instrumentations use different semantic conventions.
The request span carries `http.request.method` and `http.response.status_code`; the Supabase
spans carry `http.method` and `http.status_code`. A filter written for one set silently
matches none of the other's spans. Neither library still offers the
`OTEL_SEMCONV_STABILITY_OPT_IN` knob, and replacing the fetch instrumentation was
prototyped and rejected — the reasoning and the measurements are in
[`docs/opentelemetry-on-vercel.md`](./docs/opentelemetry-on-vercel.md#semantic-conventions-are-split).

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

These turn traces into questions about the business rather than about HTTP. *"Every trace
where `inventory.movement_kind = issue` took over 500ms"* is not answerable from a URL and
a duration.

`inventory.stock_rows_scanned` alongside `inventory.low_stock_count` is the pair that
distinguishes "this report is slow because there is a lot to report" from "this report is
slow because it scans everything either way".

### Platform context

`src/telemetry/platformContext.js` adds three attributes to the request span.

| Attribute | Meaning |
| --- | --- |
| `faas.coldstart` | `true` on the first request through an instance, `false` after |
| `faas.init_duration_ms` | `process.uptime()` at that first request; cold starts only |
| `vercel.request_id` | the `x-vercel-id` header; absent locally |

`faas.init_duration_ms` covers module loading, the Supabase client, and the OTel SDK. It
does not include container boot before Node started, which is not observable from inside
the function — treat it as a floor.

`vercel.request_id` is what matches a SigNoz trace to the same request in Vercel's runtime
logs.

`registerOTel` accepts an `attributesFromHeaders` option that appears to cover the last of
these. It does not apply here: it decorates spans `@vercel/otel` creates itself, and the
request span in this app comes from `HttpInstrumentation`. The header is read directly.

**Faults and business outcomes are recorded differently.** A Supabase failure records an
exception and sets an error span status. A 404 for an unknown item, or a 409 for
insufficient stock, does not — that is the system working correctly and telling the caller
no. Marking those red would turn the error rate into a measure of how often people ask for
something unavailable.

Both still carry `app.error.status`, and a rejected movement adds a `movement.rejected`
span event with what was requested and what was available. Queryable either way; only one
of them pages anybody.

### Why not `instrumentation-express`

It would add route and middleware spans with no code at all. It patches a userland
package, which under ESM needs `--experimental-loader` at process start — and Vercel
provides no way to pass Node flags to the function runtime. It cannot be registered from
inside `instrumentation.js` either, because ESM loads the whole module graph before any
module body runs, so Express is already resolved by then.

Ten lines of renaming buys the same span name without the constraint.

### Business metrics

One counter, in `src/telemetry/metrics.js`.

| Metric | Type | Attributes |
| --- | --- | --- |
| `inventory.units_moved` | Counter | `inventory.movement_kind`, `inventory.location_id` |

Units, not events. One movement of 500 units and 500 movements of 1 unit are the same
row count and very different business activity — a request-rate chart cannot tell them
apart.

Always incremented by a positive number. Direction lives in `movement_kind`, so one series
sums to total throughput or splits to compare receipts against issues.

Incremented only after both writes land. A rejected or failed movement moved no stock.

**Attributes are kept deliberately small.** 4 kinds across 8 locations is 32 series. Item id
is excluded — 240 items would be 7,680 series for one counter, and per-item volume is a
question for the ledger, not a metric.

**DELTA temporality is required, not a preference.** Each function instance keeps its own
counter and instances come and go. Under the default CUMULATIVE the backend sees many
independent running totals that restart at zero, and summing them is wrong. DELTA reports
"what happened since the last export", which merges correctly across instances.

The export interval is 10s. A frozen function exports nothing, so a short interval means
anything still buffered is late rather than lost.

### Logs, correlated to traces

`src/telemetry/logger.js` writes every line twice:

- to **stdout**, where Vercel collects it as a runtime log. Hobby keeps those for one hour.
- as an **OTel log record**, exported to SigNoz over OTLP.

Both carry the same `trace_id` and `span_id`, so a line found in either can be followed
into the other, and from either into the trace.

```
stdout   {"level":"warn","msg":"POST /api/movements failed", … ,"trace_id":"cf1462e1e3…"}
SigNoz   [WARN] POST /api/movements failed  trace_id=cf1462e1e3… span_id=cb21dfae74…
```

The severity split matters: a request rejected with a 4xx logs at `warn`, a fault at
`error`. A burst of 409s is worth seeing without it counting as an outage.

With telemetry disabled the OTel side is a no-op — the logs API does nothing without a
registered provider — and lines still reach stdout, without trace ids.

A purpose-built logger is used rather than pino, to avoid a transport setup that is awkward
in a serverless function. Pino is the production swap.

### Trace context into Supabase

The trace stops at the network boundary unless something carries it across. `@vercel/otel`
does not: its `fetch` instrumentation propagates context only to same-origin and Vercel
deployment URLs, and `supabase.co` is neither. Every Supabase call was traced on our side
and anonymous on theirs.

`src/supabase.js` turns on `supabase-js`'s own propagation:

```js
import '@supabase/supabase-js/tracing'

createClient(url, key, { …, tracePropagation: true })
```

The import registers the OpenTelemetry extractor; the option switches it on. Both are
needed — the option alone logs a one-time warning and sends nothing, which is why they sit
in the same file. No new dependency: `@opentelemetry/api` is already here, and the subpath
ships with `supabase-js` 2.112.

Every Supabase request now carries `traceparent`, and that `trace_id` appears in Supabase's
API Gateway logs. The same id identifies the trace in SigNoz, so an slow PostgREST call can
be read from either side.

Two things worth knowing:

- **The header names the service span, not the `fetch` span.** `supabase-js` builds its
  headers before the patched `fetch` opens its span, so the active context is still
  `inventory.items.list`. Same trace either way, and `trace_id` is the join key, so this
  only matters if exact parent-child nesting across the boundary is ever wanted.
- **`respectSamplingDecision` is left at its default of `true`.** Nothing is sampled out
  today, so it changes nothing. Adding a sampler later would stop unsampled requests
  carrying a `trace_id` into Supabase's logs; set it to `false` to keep tagging them.

The header only ever goes to `*.supabase.co`, `*.supabase.in` and `localhost` —
`supabase-js` enforces that, so a custom `fetch` to a third-party host is never tagged.

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

- **Time before the code runs** — CDN routing, queueing, container boot. `faas.init_duration_ms`
  measures from Node's start, so it is a floor on cold-start cost, not the whole of it. Vercel
  Trace Drains close this gap by forwarding infrastructure spans, but need a **Pro or
  Enterprise** plan ($0.50 per drains volume unit).
- **Requests that never reach the function** — CDN cache hits, edge 404s. Close to zero
  here, since every route is dynamic and nothing is cached.
- **Stock levels as a metric.** `inventory.low_stock_count` exists as a span attribute, so
  it is only computed when someone calls the report. A gauge meaning "the last time anyone
  looked, it was 174" is misleading on a dashboard and worse in an alert. Measuring it
  continuously needs a scheduled reader, which a function that freezes between requests
  cannot provide.

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
