import { metrics } from '@opentelemetry/api'

// With no meter provider registered, the metrics API is a no-op, so this is
// safe to call whether or not telemetry is configured.
const meter = metrics.getMeter('inventory-service')

/**
 * Units of stock moved, counted at the moment a movement is committed.
 *
 * Deliberately units rather than events. One movement of 500 units and 500
 * movements of 1 unit are the same row count and very different business
 * activity — a request-rate chart cannot tell them apart.
 *
 * Always incremented by a positive number. Direction lives in the
 * `inventory.movement_kind` attribute, so a single series can be summed for
 * total throughput or split to compare receipts against issues.
 */
const unitsMoved = meter.createCounter('inventory.units_moved', {
  description: 'Units of stock moved by a committed movement',
  unit: '{unit}'
})

/**
 * Attributes are kept to movement kind and location — 4 kinds across 8 locations
 * is 32 series, which is nothing. Item id is deliberately excluded: 240 items
 * would be 7,680 series for one counter, and per-item volume is a question for
 * the ledger, not for a metric.
 */
export function recordUnitsMoved({ kind, locationId, quantity }) {
  unitsMoved.add(Math.abs(quantity), {
    'inventory.movement_kind': kind,
    'inventory.location_id': locationId
  })
}
