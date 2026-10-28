import {
  executeBatch,
  queryAllPrimary,
  queryBatchPrimary,
} from "#db/client.ts";
import { noArgStatements } from "./schema-sync.ts";
import type { MigrationBuilder } from "./types.ts";

/**
 * The dormant buyer-bearing payment tables `2026-07-26_payment_records`
 * created but nothing ever wrote to. Their buyer-bearing columns accept
 * DB-key `enc:1` ciphertext. This release rebuilds them to require owner-key
 * `hyb:1` ciphertext, so an upgrading site's copies must go before the
 * declarative apply runs — see the ordering note in `up()`.
 */
const DORMANT_PAYMENT_TABLES = [
  "payment_sessions",
  "payment_completion_deliveries",
  "payment_cases",
  "payment_case_decisions",
] as const;

const tableSlots = DORMANT_PAYMENT_TABLES.map(() => "?").join(", ");

/** How many rows each dormant table that still exists is holding. */
const storedRowCounts = async (): Promise<Map<string, number>> => {
  const present = await queryAllPrimary<{ name: string }>({
    args: [...DORMANT_PAYMENT_TABLES],
    sql:
      "SELECT name FROM sqlite_master " +
      `WHERE type = 'table' AND name IN (${tableSlots})`,
  });
  const names = present.map((row) => row.name);
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
 * Drop the dormant tables so the apply below recreates them from SCHEMA.
 * They are empty on every site — nothing has ever written one — and the guard
 * keeps that assumption loud rather than letting a drop take real money
 * history with it.
 */
const clearDormantPaymentTables = async (): Promise<void> => {
  const stored = await storedRowCounts();
  for (const [name, rows] of stored) {
    if (rows > 0) {
      throw new Error(
        `${name} is not empty; refusing to drop stored payment ` +
          "history that lacks owner-key protection",
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
      "Rebuild the dormant payment tables to require owner-key hyb:1 " +
      "ciphertext: drop the empty tables so the apply recreates them with " +
      "the owner-key checks",
    id: "2026-10-28_dormant_payment_owner_key",
    requires: {
      indexes: [
        "idx_payment_sessions_reference",
        "idx_payment_sessions_reconcile",
        "idx_payment_sessions_attendee",
        "idx_payment_sessions_redaction",
        "idx_payment_completion_deliveries_unique",
        "idx_payment_completion_deliveries_pending",
        "idx_payment_cases_payment_resource",
        "idx_payment_cases_reconcile",
        "idx_payment_cases_alert",
        "idx_payment_cases_redaction",
        "idx_payment_case_decisions_revision",
        "idx_payment_case_decisions_retry",
      ],
      newTables: [...DORMANT_PAYMENT_TABLES],
    },
    up: async () => {
      // Order is the whole point of merging this work into one migration.
      // applySchemaChanges reconciles the WHOLE schema, and for a table that
      // already exists it can only ADD COLUMN. It cannot change a column's
      // CHECK constraint, so an upgrading site's copies would keep the
      // DB-key `enc:1` rule. Dropping the dormant tables first means every
      // one of them is missing when the apply runs, and a missing table is
      // created by a single CREATE carrying every column and its new check.
      // No trigger reads these tables, so dropping them cannot drop one and
      // there is nothing for syncTriggers to restore.
      await clearDormantPaymentTables();
      await context.applySchemaChanges();
      await context.syncIndexes();
    },
  })) satisfies MigrationBuilder;
