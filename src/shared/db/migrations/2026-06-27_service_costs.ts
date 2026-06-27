import { schemaMigration } from "./define.ts";

/**
 * First-class service-cost records. `recordServiceCost` posts an append-only
 * `service_cost` leg against `cost:<listingId>` (the ledger carries no
 * servicing-event id on its legs), so a service event's recorded costs could
 * not previously be listed on `/admin/servicing/:id` — the edit route existed
 * but no operator-reachable list of costs (amount, date, memo, listing, edit
 * controls) did. This adds a `service_costs` row per `recordServiceCost` call,
 * linking the original cost leg (`transfer_id`) to the servicing event, so
 * `getServicingCosts(servicingId)` can scope the cost list to one event. Each
 * record's CURRENT amount is still derived from the ledger (the original leg
 * plus its `service_cost` adjustment legs); the ledger stays append-only.
 *
 * Existing cost legs (recorded before this migration) carry no servicing link,
 * so they are not backfilled into `service_costs` — they still count in
 * `costOf(listing)`, they simply don't surface in the per-event cost list. New
 * costs are listed as soon as they are recorded.
 */
export default schemaMigration(
  "2026-06-27_service_costs",
  "Add a service_costs table backing first-class, per-event service-cost records for /admin/servicing/:id.",
  {
    indexes: ["idx_service_costs_servicing", "idx_service_costs_transfer"],
    newTables: ["service_costs"],
  },
);
