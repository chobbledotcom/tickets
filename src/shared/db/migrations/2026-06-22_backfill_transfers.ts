import { backfillTransfers } from "#shared/accounting/backfill.ts";
import { CONFIG_KEYS, settings } from "#shared/db/settings.ts";
import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-22_backfill_transfers",
  "Backfill the transfers ledger from every existing paid booking — one sale " +
    "per listing plus a payment, and a full reversal for refunded bookings — so " +
    "the ledger holds the complete money history before reads move off the " +
    "price_paid/refunded columns. No production modifier or reservation has " +
    "ever existed, so every booking is paid (or refunded) in full. Data-only: " +
    "it adds no schema objects, so it carries no `requires`; LATEST_UPDATE is " +
    "bumped so already-up-to-date sites still run it. Idempotent via the " +
    "mappers' deterministic references (INSERT OR IGNORE).",
  {},
  async () => {
    // A migration boots without the settings snapshot populated, so load COUNTRY
    // (which derives the site currency) before posting the single-currency
    // ledger. A fresh database never reaches here — it baselines every migration
    // without running up() — so this only runs on an existing site's upgrade.
    await settings.loadKeys([CONFIG_KEYS.COUNTRY]);
    await backfillTransfers(settings.currency);
  },
);
