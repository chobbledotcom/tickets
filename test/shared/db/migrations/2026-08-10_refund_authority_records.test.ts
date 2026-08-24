import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import refundAuthorityRecords from "#db/migrations/2026-08-10_refund_authority_records.ts";
import { applySchemaChanges, syncIndexes } from "#db/migrations/schema-sync.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const QUEUE_INDEX = "idx_processed_payments_protected_attendee";

/** The dormant payment-record tables besides payment_charges, which the
 *  one-table case drops so only the charge table is left to rebuild. */
const OTHER_DORMANT_TABLES = [
  "payment_sessions",
  "payment_completion_effects",
  "payment_completion_deliveries",
  "payment_cases",
  "payment_case_decisions",
];

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
        "payment_charges is not empty; refusing to reinterpret stored payment " +
          "history as refund-authority state",
      );

      await getDb().execute("DELETE FROM payment_charges");
    });

    test("rebuilds the last dormant table when it is the only one left", async () => {
      // A part-upgraded site can be down to one dormant table. Counting its
      // rows and dropping it must still happen, or the release keeps the old
      // shape and the apply has nothing to rebuild from.
      for (const table of OTHER_DORMANT_TABLES) {
        await getDb().execute(`DROP TABLE IF EXISTS ${table}`);
      }
      await givenReleasedChargeTable();

      await migration().up();

      const columns = await columnsOf("payment_charges");
      expect(columns.has("capability")).toBe(true);
      expect(columns.has("legacy_source")).toBe(false);
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
      expect(migration().description).toBe(
        "Build the durable refund authority: rebuild the dormant payment-record " +
          "tables into their refund shape, record refund confirmations and named " +
          "notes, mark which payment row proves an attendee's payment id, and " +
          "index the owner recovery queue",
      );
    });
  },
);
