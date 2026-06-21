import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-21_transfers",
  "Add transfers table: the append-only double-entry ledger (src/shared/ledger) — positive amounts moving between (type, id) accounts, with a unique reference for idempotency, account/event/time indexes, and a unique reverses_id for one-void-per-original. Balances are derived; the table is PII- and provider-id-free. Created but not yet written to (Phase 0).",
  {
    indexes: [
      "idx_transfers_reference",
      "idx_transfers_source",
      "idx_transfers_dest",
      "idx_transfers_occurred_at",
      "idx_transfers_event_group",
      "idx_transfers_reverses_id",
    ],
    newTables: ["transfers"],
  },
);
