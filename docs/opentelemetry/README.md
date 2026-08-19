# OpenTelemetry on Vercel: constraints and findings

Notes for instrumenting a plain Node/Express service on Vercel with ESM.

**measured** = verified in this repo against a local OTLP receiver, 2026-08-06 to 2026-08-07.

**verified in production** = confirmed 2026-08-10 on a real Vercel deployment
(`iad1`) exporting to a real collector and SigNoz, against a real Supabase project.
Everything else is cited.

## The findings

| Document | What it answers |
| --- | --- |
| [What arrives free, and what does not work out of the box](./setup.md) | Which spans appear with no code, and the three settings that look configured but are not — `registerOTel` alone, `instrumentation-express`, `attributesFromHeaders`. |
| [Outbound trace context](./trace-propagation.md) | How a `traceparent` reaches Supabase when `@vercel/otel` will not send one, which span the trace id names, and where Supabase records it. |
| [Semantic conventions and span naming](./span-conventions.md) | Why the same concept has two attribute names, why the fetch span name carried the whole URL, and the rules for naming a span. |
| [Library and framework gotchas](./library-gotchas.md) | `sdk-logs` signatures that fail silently, OTel version skew, and `req.baseUrl` resetting when an error unwinds. |
| [Platform limits, PII and cost](./platform-limits.md) | Vercel's tracing caps, what the serverless lifecycle hides, what leaves the system on a span, and what drives span volume. |

## Related

- `README.md` — configuration and what this service captures
