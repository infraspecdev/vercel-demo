# Platform limits, PII and cost

What Vercel caps, what the serverless lifecycle hides, what leaves the system on a span, and what drives the bill.

Part of [OpenTelemetry on Vercel](./README.md), where **measured** and
**verified in production** are defined.

## Vercel limits

From [Vercel's tracing docs](https://vercel.com/docs/tracing):

| Limit | Value |
| --- | --- |
| Trace data per request | 10 MB compressed |
| Span size | over 1 MB compressed is dropped, after attribute truncation |
| Edge runtime custom spans | not supported |
| Session Tracing | 1M spans/month/team, all plans |
| Trace Drains | Pro or Enterprise, $0.50 per volume unit |

Sampling: if a request carries `traceparent`, both the inbound decision and Vercel's rules
must agree. An upstream "not sampled" wins.

**Never run a Trace Drain and an in-code exporter together.** Spans arrive twice by
different paths and appear duplicated.

## Serverless lifecycle

**Use `@vercel/otel`, not a raw `NodeSDK`.** Functions freeze between requests. An unflushed
batch exporter loses its buffer. `@vercel/otel` handles that lifecycle. Vercel also notes
that manual SDK setup forfeits Session Tracing and Trace Drains.

**Cold starts are partly observable.** A module-level flag finds the first request through
an instance. `process.uptime()` at that point measures initialisation. Neither sees
container boot before Node started. Treat `faas.init_duration_ms` as a floor.

**Time before your code runs is not observable.** CDN routing, queueing and boot all happen
first. No header carries the edge receive timestamp. Only Trace Drains see that layer, and
they need Pro.

## PII

Span and log attributes are exported to a third party. Anything on a span leaves the system.

- **`fetch` spans record the full URL, including the query string.** PostgREST puts filters
  there. `?email=eq.someone@example.com` would be exported verbatim. This is the least
  obvious leak — no one wrote code to add it. It is off the span *name* now
  ([span name](./span-conventions.md#vercelotel-also-puts-the-full-url-in-the-span-name)), still on `http.url`.
- **Identifiers are data.** `inventory.item_id` is harmless. A customer id, an account
  number, or anything that identifies a person is not.
- **Error messages are recorded.** `span.recordException` captures the message, which often
  contains the value that caused the failure.
- **Redact in the exporter, not by review discipline.** An in-code exporter can filter before
  export. A Trace Drain forwards what the platform captured. If redaction is a requirement,
  export in code regardless of plan.

None of this affects the seeded demo data. It applies the moment the pattern touches real
records.

## Cost

Span volume drives cost. Fan-out multiplies it. One `/api/reports/low-stock` request is five
spans here. An endpoint looping over items would be one span per iteration.

Controls, cheapest first:

1. **Sample.** Use `traceSampler`, or `OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG`.
2. **Do not instrument hot loops.** Spans are for operations worth naming.
3. **Watch attribute size.** The per-span ceiling is 1 MB. Never attach result sets.

Demo traffic is nowhere near Vercel's 1M spans/month.
