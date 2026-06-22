import { columnDropMigration } from "./define.ts";

export default columnDropMigration(
  "2026-06-22_drop_transfers_currency",
  "transfers",
  "Drop the transfers.currency column. A site has a single currency, fixed at " +
    "setup and never changed, so the ledger neither stores nor compares a " +
    "per-transfer currency. Rebuilds transfers from the current schema (which no " +
    "longer declares currency); recreateTable preserves every other column and " +
    "rebuilds the indexes. Carries no `requires` (a bare column drop is not an " +
    "additive object). Runs BEFORE the backfill so its currency-free inserts can't " +
    "hit a NOT NULL constraint on a site whose transfers table still carries the " +
    "column from the already-applied 2026-06-22_transfers_time_int migration. The " +
    "table is empty at this point (Phase 0), so the rebuild is data-safe.",
);
