import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import dormantPaymentOwnerKey from "#db/migrations/2026-10-28_dormant_payment_owner_key.ts";
import { applySchemaChanges, syncIndexes } from "#db/migrations/schema-sync.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";
import { expectAccepted, expectRefused } from "./schema/payments/refuses.ts";

/** The dormant buyer-bearing tables this migration drops and rebuilds. */
const DORMANT_PAYMENT_TABLES = [
  "payment_sessions",
  "payment_completion_deliveries",
  "payment_cases",
  "payment_case_decisions",
] as const;

const context = buildMigrationContext({ applySchemaChanges, syncIndexes });
const migration = () => dormantPaymentOwnerKey(context);

/** One session row, the buyer's details hidden behind the owner's key. */
const storeOneSession = async (id: string): Promise<void> => {
  await getDb().execute(
    "INSERT INTO payment_sessions " +
      "(id, origin, state, created_at, updated_at, booking_intent, " +
      " result_state, ticket_state, completion_state) " +
      "VALUES (?, 'legacy', 'created', 1, 1, 'hyb:1:a:b:c', " +
      " 'none', 'none', 'none')",
    [id],
  );
};

describeWithEnv(
  "db > migrations > dormant payment owner key",
  { db: true },
  () => {
    test("refuses to rebuild a dormant table that holds payment history", async () => {
      await storeOneSession("not-empty");

      await expect(migration().up()).rejects.toThrow(
        "payment_sessions is not empty; refusing to drop stored payment " +
          "history that lacks owner-key protection",
      );

      await getDb().execute(
        "DELETE FROM payment_sessions WHERE id = 'not-empty'",
      );
    });

    test("rebuilds the empty tables demanding owner-key ciphertext", async () => {
      // The tables sit empty on every live site. The migration drops them so
      // the declarative apply can recreate them from SCHEMA with the new
      // checks — a table that already exists can only gain columns, never a
      // new CHECK rule.
      await migration().up();

      for (const table of DORMANT_PAYMENT_TABLES) {
        const result = await getDb().execute(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          [table],
        );
        expect(result.rows.length).toBe(1);
      }

      // The recreated session table demands the owner-key envelope.
      await expectAccepted(`INSERT INTO payment_sessions
        (id, origin, state, created_at, updated_at, booking_intent,
         result_state, ticket_state, completion_state)
        VALUES ('owner-key', 'legacy', 'created', 1, 1, 'hyb:1:a:b:c',
          'none', 'none', 'none')`);
      await expectRefused(`INSERT INTO payment_sessions
        (id, origin, state, created_at, updated_at, booking_intent,
         result_state, ticket_state, completion_state)
        VALUES ('db-key', 'legacy', 'created', 1, 1, 'enc:1:a:b',
          'none', 'none', 'none')`);

      await getDb().execute(
        "DELETE FROM payment_sessions WHERE id = 'owner-key'",
      );
    });

    test("rebuilds a dormant table when it is the only one left", async () => {
      // A part-upgraded site can be down to one dormant table. Counting its
      // rows and dropping it must still happen, or the release keeps the old
      // shape and the apply has nothing to rebuild from.
      for (const table of DORMANT_PAYMENT_TABLES) {
        await getDb().execute(`DROP TABLE IF EXISTS ${table}`);
      }
      // The surviving table carries the buyer-bearing columns in plain text.
      // The apply can only add columns, never re-constrain an existing one,
      // so only a drop and a recreate can put the owner-key rule in place.
      await getDb().execute(
        `CREATE TABLE payment_sessions (
           id TEXT PRIMARY KEY NOT NULL,
           origin TEXT NOT NULL,
           session_resource TEXT,
           legacy_runtime TEXT
         )`,
      );

      await migration().up();

      // The recreated table demands the owner-key envelope on the hidden
      // column that arrived in plain text.
      await expectRefused(`INSERT INTO payment_sessions
        (id, origin, state, created_at, updated_at, session_resource,
         result_state, ticket_state, completion_state)
        VALUES ('only-one', 'legacy', 'created', 1, 1, 'enc:1:a:b',
          'none', 'none', 'none')`);
    });

    test("recreates the dormant tables' indexes", async () => {
      await getDb().execute(
        "DROP INDEX IF EXISTS idx_payment_sessions_reference",
      );

      await migration().up();

      const result = await getDb().execute(
        "SELECT name FROM sqlite_master " +
          "WHERE type = 'index' AND name = 'idx_payment_sessions_reference'",
      );
      expect(result.rows.length).toBe(1);
    });

    test("declares every object it owns", () => {
      // Anything left off this list is never verified, so a partial upgrade
      // would record itself as applied.
      expect(migration().requires).toEqual({
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
      });
      expect(migration().id).toBe("2026-10-28_dormant_payment_owner_key");
      expect(migration().description).toBe(
        "Rebuild the dormant payment tables to require owner-key hyb:1 " +
          "ciphertext: drop the empty tables so the apply recreates them with " +
          "the owner-key checks",
      );
    });
  },
);
