import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import refundAuthorityRecords from "#shared/db/migrations/2026-08-10_refund_authority_records.ts";
import {
  applySchemaChanges,
  syncIndexes,
} from "#shared/db/migrations/schema-sync.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const QUEUE_INDEX = "idx_processed_payments_protected_attendee";

const context = buildMigrationContext({ applySchemaChanges, syncIndexes });
const migration = () => refundAuthorityRecords(context);

const columnsOf = async (table: string): Promise<Set<string>> => {
  const info = await getDb().execute(`PRAGMA table_info(${table})`);
  return new Set(info.rows.map((row) => String(row.name)));
};

const storedIndexSql = async (name: string): Promise<string> => {
  const result = await getDb().execute({
    args: [name],
    sql: "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
  });
  return String(result.rows[0]?.sql ?? "");
};

/** The payment_charges an already-released site is carrying: no `id`, and the
 *  pending-refund/legacy columns this release drops. */
const givenReleasedChargeTable = async (): Promise<void> => {
  await getDb().execute("DROP TABLE IF EXISTS payment_charges");
  await getDb().execute(
    `CREATE TABLE payment_charges (
       payment_id INTEGER NOT NULL DEFAULT 0,
       origin TEXT NOT NULL DEFAULT 'current',
       provider TEXT,
       resource_kind TEXT,
       provider_reference TEXT,
       reference_index TEXT,
       captured_amount INTEGER,
       currency TEXT,
       refunded_amount INTEGER,
       refund_state TEXT NOT NULL DEFAULT 'none',
       pending_refund_id TEXT,
       legacy_source TEXT,
       created_at INTEGER NOT NULL DEFAULT 0,
       updated_at INTEGER NOT NULL DEFAULT 0,
       observed_at INTEGER NOT NULL DEFAULT 0
     )`,
  );
};

describeWithEnv(
  "db > migrations > refund authority records",
  { db: true },
  () => {
    test("upgrades a released charge table that has no id column", async () => {
      await givenReleasedChargeTable();

      await migration().up();

      const columns = await columnsOf("payment_charges");
      // Adding these to the released table is impossible — SQLite refuses a new
      // PRIMARY KEY column — so arriving here proves the table was rebuilt.
      expect(columns.has("id")).toBe(true);
      expect(columns.has("capability")).toBe(true);
      expect(columns.has("refund_state_name")).toBe(true);
      expect(columns.has("refund_revision")).toBe(true);
      expect(columns.has("legacy_source")).toBe(false);
      expect(columns.has("origin")).toBe(false);
    });

    test("refuses to reinterpret a populated dormant charge table", async () => {
      await getDb().execute({
        args: [
          "hyb:1:a:b:c",
          "reference-one",
          JSON.stringify({
            evidenceRevision: 1,
            kind: "ready",
            local: { kind: "not_due" },
            nextActionAt: 10,
            readyAt: 1,
            request: {
              capability: "keyed",
              generation: 1,
              identityIndex: "request-one",
              replayUntil: 100,
            },
          }),
        ],
        sql: `INSERT INTO payment_charges
        (provider, provider_reference, reference_index,
         capability, captured_amount, currency,
         refunded_amount, refund_state, refund_state_name,
         refund_local_state, next_refund_action_at, refund_revision,
         created_at, updated_at, observed_at)
        VALUES ('stripe', ?, ?, 'keyed', 100,
          'GBP', 0, ?, 'ready', 'not_due', 10, 1, 1, 1, 1)`,
      });

      await expect(migration().up()).rejects.toThrow(
        "payment_charges is not empty",
      );

      await getDb().execute("DELETE FROM payment_charges");
    });

    test("gives the owner recovery queue its partial index", async () => {
      await getDb().execute(`DROP INDEX IF EXISTS ${QUEUE_INDEX}`);

      await migration().up();

      expect(await storedIndexSql(QUEUE_INDEX)).toContain(
        `ON processed_payments(attendee_id) WHERE protected_state != ''`,
      );
    });

    test("declares every object it owns", () => {
      // Anything left off this list is never verified, so a partial upgrade
      // would record itself as applied.
      expect(migration().requires).toEqual({
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
          "payment_sessions",
          "payment_completion_effects",
          "payment_completion_deliveries",
          "payment_charges",
          "payment_cases",
          "payment_case_decisions",
          "refund_confirmations",
          "refund_confirmation_references",
        ],
      });
      expect(migration().id).toBe("2026-08-10_refund_authority_records");
    });
  },
);
