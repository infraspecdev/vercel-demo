# Vercel + Supabase Observability Demo — Design

**Date:** 2026-08-06
**Status:** Approved (pending spec review)
**Repo:** `infraspecdev/vercel-demo`

## Purpose

Build a demo that showcases **observability**, delivered in two parts:

1. **PR #1 — base app.** A Node.js healthtech inventory application on Vercel that
   invokes Supabase APIs. No telemetry. Merged to `main`.
2. **PR #2 — telemetry.** Adds OpenTelemetry tracing and trace-correlated logging,
   exported to SigNoz. Left **open** so the client reviews it as a diff.

The value of the demo is the *diff*: a client watches instrumentation get added to a
plain Node service and sees what it buys them.

This is **not** a load test. Load generation is explicitly out of scope.

### Constraints

| Constraint | Value |
| --- | --- |
| Runtime | Node.js (client requirement — not Next.js) |
| Host | Vercel, **Hobby plan** |
| Database | Supabase, accessed via `supabase-js` (PostgREST) |
| Telemetry backend | SigNoz |
| Schema | `schema.sql`, already in repo — treated as fixed |

## Domain

Hospital inventory, per `schema.sql`:

- `locations` — wards, theatres, pharmacy, central store
- `suppliers`, `items` (240 seeded, SKU/category/reorder level)
- `stock` — quantity per (item, location); hot point reads
- `movements` — append-only ledger (receipt/issue/transfer/adjustment); 5000 seeded rows
- `purchase_orders`, `purchase_order_lines`

RLS is disabled deliberately (see the note at the top of `schema.sql`). The app uses the
service role key server-side only.

## Platform decisions

### Why not Vercel Trace Drains

Drains forward traces from Vercel to a third party with near-zero code. They require the
**Pro or Enterprise** plan ($0.50/unit volume). We are on Hobby, so traces are exported
**directly from the app** via an OTLP exporter.

This turns out to be the better artifact anyway: a drain is dashboard configuration, so
PR #2 would have had almost no reviewable content. In-code export produces a PR the client
can actually read, and it runs locally.

### What Hobby does and does not provide

Available free on Hobby:

- **Observability tab** — error rate, invocations, duration per route, External APIs section
- **Session Tracing** — 1M spans/month/team, full waterfalls including Vercel infra spans
- **Runtime Logs** — live tail with rich filtering, including a `traceId` field
- **`vercel curl --trace`** — trace a single request from the terminal

Gated behind Pro / Observability Plus:

- Trace and Log **Drains**
- Runtime log retention beyond **1 hour** (Pro: 1 day; +Observability Plus: 30 days)
- Latency breakdown by path, per-path External API detail

### The demo narrative

The 1-hour log retention ceiling on Hobby is the core argument, and it is not hypothetical:

> An incident happens at 2pm. You investigate at 4pm. On Vercel Hobby the evidence is gone.
> In SigNoz it is still there — with the Supabase call that caused it, the item ID, and the
> deployment SHA.

The framing is **not** "Vercel's observability is weak". It is:

> **Vercel shows you _now_. SigNoz shows you _then_.**

Live tail and durable history are different jobs; the client needs both.

Because `@vercel/otel` is installed, the **same trace ID appears in both Vercel logs and
SigNoz**, so the demo can pivot between the two on a single identifier.

**Demo script constraint:** never rely on Vercel logs older than one hour.

### Recovering what drains would have given us

Drains supply Vercel infrastructure spans that application code cannot generate. PR #2
includes a platform-context middleware that recovers most of the value:

| Signal | Recovered how |
| --- | --- |
| Cold start flag | module-level `warm` boolean; first request sees `false` |
| Cold start cost | `process.uptime()` at first request ≈ init duration |
| Region / env / deployment | `VERCEL_REGION`, `VERCEL_ENV`, `VERCEL_DEPLOYMENT_ID` |
| Commit attribution | `VERCEL_GIT_COMMIT_SHA` as a resource attribute |
| Correlation to Vercel logs | `x-vercel-id` request header |

**Genuinely unrecoverable** (state this honestly to the client):

1. Time elapsed before application code runs — CDN routing, queueing, container boot.
2. Requests that never reach the function — CDN cache hits, edge 404s.
3. Build and static logs.

For this app every route is dynamic and hits Supabase, so nothing is CDN-cached and (2) is
effectively zero. (1) is real but small next to Supabase latency.

### Upgrade path (documented, not built)

1. Upgrade to Pro.
2. Add a Trace Drain pointing at the SigNoz OTLP endpoint.
3. Remove the in-code exporter — a subtraction of ~15 lines, not a rewrite.

Do **not** run both simultaneously in steady state: spans would be delivered twice by
different paths and appear duplicated in SigNoz.

Prerequisite for drains: the SigNoz OTLP endpoint must be publicly reachable with header
auth. SigNoz Cloud satisfies this; a self-hosted instance behind a VPN would need exposing.

## PR #1 — Base application

### Layout

```
vercel-demo/
├── schema.sql               # already in repo
├── vercel.json              # rewrite all paths -> api/index.js
├── .env.example
├── package.json
├── api/index.js             # Vercel entrypoint: exports the Express app
├── server.js                # local entrypoint: app.listen()
└── src/
    ├── app.js               # express assembly, middleware, error handler
    ├── supabase.js          # supabase-js client factory
    ├── services/            # data access — the seam telemetry wraps
    │   ├── items.js
    │   ├── stock.js
    │   └── movements.js
    ├── routes/
    │   ├── api.js           # JSON endpoints
    │   └── pages.js         # server-rendered HTML
    └── views/               # template-literal HTML, no build step
```

### Design rationale

**`services/` is a distinct layer.** It is the single place Supabase is called. PR #2 wraps
that one layer and thereby covers every endpoint. Without this seam, instrumentation would
be smeared across route handlers and PR #2 would read as noise instead of as a tutorial.
This is the decision that makes the second PR small and legible.

**Two entrypoints, one app.** `server.js` gives a real long-lived process locally;
`api/index.js` is what Vercel invokes. Neither contains logic — both import `src/app.js`.

**No build step.** Plain JS; HTML via template literals. The client sees Node, not a toolchain.

### JSON API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/locations` | wards, theatres, pharmacy, store |
| `GET /api/items?category=&q=` | filtered item list |
| `GET /api/items/:id` | item plus stock across all locations |
| `GET /api/stock?location=WARD-A` | stock at one location |
| `GET /api/reports/low-stock` | items below `reorder_level` |
| `GET /api/movements?item_id=&limit=` | ledger reads |
| `POST /api/movements` | record receipt/issue/transfer/adjustment |
| `GET /health` | liveness |

### Pages (server-rendered HTML)

- `/` — dashboard: counts and low-stock list
- `/items` — list with category filter
- `/items/:id` — detail, stock by location, recent movements
- `/locations/:code` — stock at a location
- `/movements` — recent ledger plus a form to record a movement

### Two deliberate shapes

**`POST /api/movements` performs two Supabase calls** — insert the ledger row, then update
`stock.quantity`. This is intentional: it produces a multi-span trace that makes the value
of tracing self-evident.

Honest caveat, to be stated in the README: two PostgREST calls are not atomic. A crash
between them leaves `stock` drifted from the ledger. Acceptable for a demo; production
would use a Postgres function invoked via RPC. The README must say so, so the client does
not mistake it for a recommendation.

**`GET /api/reports/low-stock` fans out** across `stock` and `items`. It is the slowest
endpoint by design — the one where a trace says something a log line cannot.

### Configuration

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, server-side only, documented in
`.env.example`. The README must state that the service role key must never reach a browser.

No real credentials exist yet; the app is built against documented env vars.

## PR #2 — Telemetry

Goal: **`git diff` should read as a tutorial.** Base application logic is untouched.

### Files added

```
instrumentation.js              # registerOTel + SigNoz exporters + resource attributes
src/telemetry/withSpan.js       # wrap a function in a span
src/telemetry/platform.js       # cold start, region, x-vercel-id
src/telemetry/traceContext.js   # extract inbound traceparent (Express needs this manually)
src/telemetry/logger.js         # dual-output logger: console + OTLP logs
```

### Files changed

| File | Change |
| --- | --- |
| `api/index.js`, `server.js` | `require('./instrumentation')` as the first line |
| `src/app.js` | register the platform and trace-context middleware |
| `src/services/*.js` | wrap each function in `withSpan(...)` — small, repetitive, reviewable |
| `src/routes/*.js` | replace `console.log` with the structured logger |
| `package.json` | add dependencies |
| `.env.example`, `README.md` | OTel configuration and demo script |

### Dependencies

Traces:
- `@opentelemetry/api`
- `@vercel/otel`
- `@opentelemetry/exporter-trace-otlp-http`

Logs:
- `@opentelemetry/api-logs`
- `@opentelemetry/sdk-logs`
- `@opentelemetry/exporter-logs-otlp-http`

### Why `@vercel/otel` rather than a raw `NodeSDK`

- It is built for the Vercel function lifecycle, so span flushing on function freeze is
  handled rather than hand-rolled. This was the main risk of running Express on serverless.
- It supports non-Next.js apps: the docs specify a `framework=other` variant that calls
  `registerOTel()` at module top level in a root `instrumentation.js`.
- It instruments `fetch`. `supabase-js` calls Supabase over `fetch`, so **every Supabase API
  call becomes a span with no additional code**.

Known gap: automatic context propagation for *incoming* requests is Next.js-only. Express
must extract the inbound `traceparent` manually — hence `src/telemetry/traceContext.js`.

### Trace shape

```
GET /api/reports/low-stock              ← root span, route-named
├─ inventory.stock.lowStock             ← service span
│  └─ HTTP GET supabase.co/rest/v1/stock    ← free, via fetch instrumentation
└─ inventory.items.byIds
   └─ HTTP GET supabase.co/rest/v1/items
```

`POST /api/movements` yields two sequential Supabase spans, making the non-atomic write
visible rather than merely described.

### Attributes

**Resource** (on every span and log record):
`service.name`, `deployment.environment` (`VERCEL_ENV`), `vercel.region`,
`vercel.deployment_id`, `git.commit_sha` (`VERCEL_GIT_COMMIT_SHA`)

**Platform** (per request):
`faas.coldstart`, `faas.init_duration_ms`, `vercel.request_id` (`x-vercel-id`)

**Domain** (per operation):
`inventory.item_id`, `inventory.location_code`, `inventory.movement_kind`,
`inventory.low_stock_count`

The domain attributes are what make this healthtech rather than generic. *"Show me every
trace where `inventory.movement_kind = issue` took over 500ms"* is a question the client
will recognise as their own.

### Errors

Service spans record exceptions via `span.recordException()` and set span status to `ERROR`.
The Express error handler marks the root span and emits an error log record.

### Trace-correlated logging

`src/telemetry/logger.js` writes each line **twice**:

1. To `console` — so it appears in Vercel's live tail (1-hour retention on Hobby).
2. As an OTel `LogRecord` via the OTLP logs exporter — so it persists in SigNoz.

Both carry `trace_id` and `span_id` from the active context. This is what enables the
Vercel ↔ SigNoz pivot in the demo.

A small purpose-built logger is used rather than pino, to avoid a transport setup that is
awkward in serverless. The README notes pino as the production swap.

### Non-negotiable behaviours

**Graceful no-op.** If `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, instrumentation does nothing
and the app runs normally. A forgotten env var must not be able to break the demo.

**No secrets in code.** The SigNoz endpoint and ingestion key come from env, documented in
`.env.example`.

### Configuration

| Variable | Purpose |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | SigNoz OTLP HTTP endpoint; unset disables telemetry |
| `SIGNOZ_INGESTION_KEY` | sent as the `signoz-ingestion-key` header |
| `OTEL_SERVICE_NAME` | service name in SigNoz; defaults to `vercel-demo` |

## Out of scope

- Load generation / load testing
- Custom OTel **metrics** (deferred; a possible PR #3)
- Vercel Trace Drains configuration (documented as the Pro upgrade path only)
- Supabase Prometheus metrics scraping into SigNoz
- Authentication, RLS policies, multi-tenancy
- `purchase_orders` / `purchase_order_lines` endpoints — present in the schema but not
  needed for the demo narrative

## Delivery

1. Branch `feat/base-app` → PR #1 → **merge to `main`**. `main` is a working, deployable app.
2. Branch `feat/telemetry` off `main` → PR #2 → **left open** for the client to review live.

Per repo conventions: branches are created from `origin/main`; no AI attribution in commits
or PR descriptions.

## Success criteria

- [ ] `main` runs locally via `npm start` and deploys to Vercel with no telemetry configured.
- [ ] All eight API endpoints and five pages return correct data from Supabase.
- [ ] PR #2's diff is readable end to end in a single sitting.
- [ ] With SigNoz configured, `GET /api/reports/low-stock` produces a trace showing the root
      span, service spans, and Supabase fetch spans.
- [ ] `POST /api/movements` produces a trace with two distinct Supabase spans.
- [ ] A log line in SigNoz and the corresponding Vercel runtime log share a `trace_id`.
- [ ] With `OTEL_EXPORTER_OTLP_ENDPOINT` unset, the app behaves exactly as `main` does.
- [ ] README documents: setup, the Hobby-vs-Pro table, the drains upgrade path, the
      non-atomic write caveat, and the demo script.

## Open risks

| Risk | Mitigation |
| --- | --- |
| No Supabase / SigNoz / Vercel credentials yet | Build against `.env.example`; verify locally once credentials exist |
| Span loss on function freeze | `@vercel/otel` manages the lifecycle; verify with a deployed request before the demo |
| Express root spans may not be route-named automatically | Create the root span explicitly in middleware using the matched route |
| SigNoz Cloud region affects the OTLP endpoint URL | Parameterised via env var, not hardcoded |
