import { executeBatch, queryBatchPrimary } from "#db/client.ts";
import { noArgStatements } from "./schema-sync.ts";
import type { MigrationBuilder } from "./types.ts";

/**
 * The payment-record tables `2026-07-26_payment_records` created but nothing
 * ever wrote to. This release redefines every one of them, so an upgrading
 * site's copies must go before the declarative apply runs — see the ordering
 * note in `up()`.
 */
const DORMANT_PAYMENT_TABLES = [
  "payment_sessions",
  "payment_completion_effects",
  "payment_completion_deliveries",
  "payment_charges",
  "payment_cases",
  "payment_case_decisions",
] as const;

const tableSlots = DORMANT_PAYMENT_TABLES.map(() => "?").join(", ");

/** How many rows each dormant table that still exists is holding. */
const storedRowCounts = async (): Promise<Map<string, number>> => {
  const [present] = await queryBatchPrimary([
    {
      args: [...DORMANT_PAYMENT_TABLES],
      sql:
        "SELECT name FROM sqlite_master " +
        `WHERE type = 'table' AND name IN (${tableSlots})`,
    },
  ]);
  const names = present!.rows.map((row) => String(row.name));
  if (names.length === 0) return new Map();
  const counts = await queryBatchPrimary(
    names.map((name) => ({
      args: [],
      sql: `SELECT COUNT(*) AS stored FROM ${name}`,
    })),
  );
  return new Map(
    names.map((name, index) => [name, Number(counts[index]!.rows[0]!.stored)]),
  );
};

/**
 * Drop the dormant payment-record tables so the apply below recreates them
 * from SCHEMA. They are empty on every site — nothing has ever written one —
 * and the guard keeps that assumption loud rather than letting a drop take
 * real money history with it.
 */
const clearDormantPaymentTables = async (): Promise<void> => {
  const stored = await storedRowCounts();
  for (const [name, rows] of stored) {
    if (rows > 0) {
      throw new Error(
        `${name} is not empty; refusing to reinterpret stored payment ` +
          "history as refund-authority state",
      );
    }
  }
  if (stored.size === 0) return;
  await executeBatch(
    noArgStatements([...stored.keys()].map((n) => `DROP TABLE IF EXISTS ${n}`)),
  );
};

export default ((context) =>
  context.additive({
    description:
      "Build the durable refund authority: rebuild the dormant payment-record " +
      "tables into their refund shape, record refund confirmations and named " +
      "notes, mark which payment row proves an attendee's payment id, and " +
      "index the owner recovery queue",
    id: "2026-08-10_refund_authority_records",
    requires: {
      columns: {
        attendees: ["pii_payment_session_id"],
        processed_payments: ["protected_state", "payment_reference_index"],
        system_notes: ["system_name"],
      },
      indexes: [
        "idx_payment_charges_callback_replay",
        "idx_payment_charges_next_action",
        "idx_payment_charges_reference",
        "idx_payment_charges_refund_state",
        "idx_processed_payments_protected_attendee",
        "idx_processed_payments_reference_index",
        "idx_refund_confirmation_references_unique",
        "idx_refund_confirmations_attendee",
        "idx_system_notes_named_unique",
      ],
      newTables: [
        ...DORMANT_PAYMENT_TABLES,
        "refund_confirmations",
        "refund_confirmation_references",
      ],
    },
    up: async () => {
      // Order is the whole point of merging this work into one migration.
      // applySchemaChanges reconciles the WHOLE schema, and for a table that
      // already exists it can only ADD COLUMN. An upgrading site's
      // payment_charges is a different table from this one — it has no `id`,
      // and SQLite refuses to add a PRIMARY KEY column — so the apply would
      // stop the upgrade dead. Dropping the dormant tables first means every
      // one of them is missing when the apply runs, and a missing table is
      // created by a single CREATE carrying every column.
      // No trigger reads these tables, so dropping them cannot drop one and
      // there is nothing for syncTriggers to restore.
      await clearDormantPaymentTables();
      await context.applySchemaChanges();
      await context.syncIndexes();
    },
  })) satisfies MigrationBuilder;
