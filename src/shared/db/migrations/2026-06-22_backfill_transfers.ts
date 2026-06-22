import { backfillTransfers } from "#shared/accounting/backfill.ts";
import { CONFIG_KEYS, settings } from "#shared/db/settings.ts";
import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-22_backfill_transfers",
  "Backfill the transfers ledger from every existing paid booking row — sale + payment = price_paid, plus a full reversal for refunded rows — so the ledger holds the complete money history before reads migrate off the price_paid/refunded columns. No production modifier or reservation has ever existed, so each booking is paid in full. Idempotent via the mappers' deterministic reference keys.",
  {},
  async () => {
    // Resolve the site currency (its snapshot field is driven by COUNTRY) before
    // posting: a migration boots without the settings snapshot populated.
    await settings.loadKeys([CONFIG_KEYS.COUNTRY]);
    await backfillTransfers(settings.currency);
  },
);
