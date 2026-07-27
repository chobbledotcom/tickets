import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { encrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { getDb, resultRows } from "#shared/db/client.ts";
import paymentAggregateMigration from "#shared/db/migrations/2026-07-26_payment_aggregate.ts";
import { MigrationInProgressError } from "#shared/db/migrations/errors.ts";
import { paymentStoredJson } from "#shared/db/payments/codecs.ts";
import { runWithQueryLogContext } from "#shared/db/query-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  context,
  insertProcessedRow,
  restoreLegacyPaymentSources,
  runMigration,
  runMigrationInvocation,
} from "./payment-aggregate-test-utils.ts";

const PROCESSED_AT = "2026-07-25T10:00:00.000Z";
const STAGE_AT = "2026-07-25T11:00:00.000Z";
const SUMUP_AT = "2026-07-25T12:00:00.000Z";

type LegacyCiphertexts = {
  failureData: string;
  metadata: string;
  ticketTokens: string;
};

const seedLegacyRows = async (
  existing?: LegacyCiphertexts,
): Promise<LegacyCiphertexts> => {
  const generated = await Promise.all([
    encrypt("ticket-one+ticket-two"),
    encrypt('{"error":"sold out","status":409}'),
    encrypt('{"name":"Legacy customer"}'),
  ]);
  const [ticketTokens, failureData, metadata] = existing
    ? [existing.ticketTokens, existing.failureData, existing.metadata]
    : generated;
  await getDb().batch(
    [
      {
        args: [
          "legacy-processed",
          null,
          PROCESSED_AT,
          ticketTokens,
          failureData,
          "hyb:1:legacy-provider-reference",
          "",
        ],
        sql: `INSERT INTO processed_payments
          (payment_session_id, attendee_id, processed_at, ticket_tokens,
           failure_data, payment_reference, provider_refunded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
      },
      {
        args: ["legacy-stage", 42, "stripe", ticketTokens, "pending", STAGE_AT],
        sql: `INSERT INTO checkout_stages
          (payment_session_id, attendee_id, provider, ticket_tokens, state, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
      },
      {
        args: [
          "legacy-reference-index",
          "wk:1:legacy-wrapped-key",
          metadata,
          "sumup-checkout-1",
          SUMUP_AT,
        ],
        sql: `INSERT INTO sumup_checkouts
          (reference_index, wrapped_key, metadata, sumup_id, created_at)
          VALUES (?, ?, ?, ?, ?)`,
      },
    ],
    "write",
  );
  return { failureData, metadata, ticketTokens };
};

const aggregateRows = () =>
  getDb().execute(`SELECT id, provider, mode, account_id, expected_amount,
      expected_currency, attendee_id, state, result_state, result,
       ticket_state, ticket_tokens, completion_state, checkout_create,
       legacy_runtime
    FROM payment_sessions WHERE origin = 'legacy' ORDER BY created_at`);

const expectProcessedSourceKept = async (): Promise<void> => {
  const source = await getDb().execute(
    "SELECT payment_session_id FROM processed_payments",
  );
  expect(source.rows).toEqual([
    { payment_session_id: "one-processed-payment" },
  ]);
};

describeWithEnv(
  "db > migrations > 2026-07-26_payment_aggregate",
  { db: true },
  () => {
    beforeEach(restoreLegacyPaymentSources);

    test("declares the complete aggregate schema", () => {
      const migration = paymentAggregateMigration(context);
      expect({
        description: migration.description,
        id: migration.id,
        requires: migration.requires,
      }).toEqual({
        description:
          "Create durable payments, preserve legacy runtime facts, retry uncertain work, and queue operator alerts.",
        id: "2026-07-26_payment_aggregate",
        requires: {
          indexes: [
            "idx_payment_sessions_reference",
            "idx_payment_sessions_reconcile",
            "idx_payment_sessions_attendee",
            "idx_payment_charges_payment_reference",
            "idx_payment_charges_reference",
            "idx_payment_charges_pending_refund",
            "idx_payment_charges_legacy_source",
            "idx_payment_cases_payment_resource",
            "idx_payment_cases_reconcile",
            "idx_payment_cases_alert",
          ],
          newTables: ["payment_sessions", "payment_charges", "payment_cases"],
        },
      });
    });

    test("preserves each legacy runtime without inventing ownership or money", async () => {
      const original = await seedLegacyRows();

      await runMigration();

      const sessions = await aggregateRows();
      expect(sessions.rows).toHaveLength(3);
      expect(sessions.rows.map((row) => row.checkout_create)).toEqual([
        null,
        null,
        null,
      ]);
      expect(
        sessions.rows.map((row) => ({
          account: row.account_id,
          amount: row.expected_amount,
          completion: row.completion_state,
          currency: row.expected_currency,
          mode: row.mode,
          provider: row.provider,
          result: row.result_state,
          state: row.state,
          ticket: row.ticket_state,
        })),
      ).toEqual([
        {
          account: null,
          amount: null,
          completion: "none",
          currency: null,
          mode: null,
          provider: null,
          result: "failed",
          state: "failed",
          ticket: "ready",
        },
        {
          account: null,
          amount: null,
          completion: "none",
          currency: null,
          mode: null,
          provider: "stripe",
          result: "none",
          state: "pending",
          ticket: "ready",
        },
        {
          account: null,
          amount: null,
          completion: "none",
          currency: null,
          mode: null,
          provider: "sumup",
          result: "none",
          state: "pending",
          ticket: "none",
        },
      ]);
      const runtimes = await Promise.all(
        resultRows<{ legacy_runtime: EnvKeyEncrypted }>(sessions).map((row) =>
          paymentStoredJson.legacyRuntime.open(
            row.legacy_runtime,
            "test legacy runtime",
          ),
        ),
      );
      expect(runtimes[0]?.processedPayment).toMatchObject({
        failureData: original.failureData,
        paymentReference: "hyb:1:legacy-provider-reference",
        ticketTokens: original.ticketTokens,
      });
      expect(runtimes[1]?.checkoutStage).toMatchObject({
        provider: "stripe",
        state: "pending",
        ticketTokens: original.ticketTokens,
      });
      expect(runtimes[2]?.sumupCheckout).toEqual({
        createdAt: SUMUP_AT,
        metadata: original.metadata,
        referenceIndex: "legacy-reference-index",
        sumupId: "sumup-checkout-1",
        wrappedKey: "wk:1:legacy-wrapped-key",
      });
      expect(sessions.rows[0]?.result).toBe(original.failureData);
      const charges = await getDb().execute(`SELECT provider_reference,
        refund_state FROM payment_charges`);
      expect(charges.rows).toEqual([
        {
          provider_reference: "hyb:1:legacy-provider-reference",
          refund_state: "unknown",
        },
      ]);
    });

    test("drains only rows whose encrypted evidence was copied exactly", async () => {
      await seedLegacyRows();

      await runMigration();

      const counts = await getDb().execute(`SELECT
        (SELECT COUNT(*) FROM processed_payments) AS processed,
        (SELECT COUNT(*) FROM checkout_stages) AS stages,
        (SELECT COUNT(*) FROM sumup_checkouts) AS sumup`);
      expect(counts.rows[0]).toEqual({ processed: 0, stages: 0, sumup: 0 });
    });

    test("continues a large legacy source across guarded invocations", async () => {
      const sourceRows = Array.from({ length: 126 }, (_, index) => ({
        args: [
          `paged-payment-${String(index).padStart(3, "0")}`,
          PROCESSED_AT,
          "enc:1:legacy-failure",
        ],
        sql: `INSERT INTO processed_payments
          (payment_session_id, processed_at, failure_data) VALUES (?, ?, ?)`,
      }));
      await getDb().batch(sourceRows, "write");
      const client = getDb();
      const originalBatch = client.batch.bind(client);
      const batchSizes: number[] = [];
      using _batch = stub(client, "batch", (statements, mode) => {
        batchSizes.push(statements.length);
        return originalBatch(statements, mode);
      });

      let invocations = 0;
      let continuing = true;
      while (continuing) {
        invocations += 1;
        continuing = await runWithQueryLogContext(async () => {
          try {
            await runMigrationInvocation();
            return false;
          } catch (error) {
            if (error instanceof MigrationInProgressError) return true;
            throw error;
          }
        });
      }

      expect(invocations).toBeGreaterThan(1);
      expect(Math.max(...batchSizes)).toBeLessThanOrEqual(25);
      const counts = await getDb().execute(`SELECT
        (SELECT COUNT(*) FROM processed_payments) AS source,
        (SELECT COUNT(*) FROM payment_sessions WHERE origin = 'legacy') AS copied`);
      expect(counts.rows[0]).toEqual({ copied: 126, source: 0 });
    });

    test("refuses old payment writes after the sources are drained", async () => {
      const original = await seedLegacyRows();
      await runMigration();

      await expect(seedLegacyRows(original)).rejects.toThrow(
        "legacy payment source is closed",
      );

      const counts = await getDb().execute(`SELECT
        (SELECT COUNT(*) FROM payment_sessions WHERE origin = 'legacy') AS sessions,
        (SELECT COUNT(*) FROM payment_charges WHERE origin = 'legacy') AS charges,
        (SELECT COUNT(*) FROM payment_cases) AS cases,
        (SELECT COUNT(*) FROM processed_payments) AS remaining`);
      expect(counts.rows[0]).toEqual({
        cases: 3,
        charges: 1,
        remaining: 0,
        sessions: 3,
      });
    });

    test("is an idempotent no-op when no legacy rows remain", async () => {
      await runMigration();
      await runMigration();
      expect((await aggregateRows()).rows).toEqual([]);
    });

    test("fails before copying or draining a malformed source row", async () => {
      await getDb().execute(`INSERT INTO processed_payments
        (payment_session_id, attendee_id, processed_at)
        VALUES ('malformed-payment', NULL, 'not-a-time')`);

      await expect(runMigration()).rejects.toThrow();

      const source = await getDb().execute(
        "SELECT payment_session_id FROM processed_payments",
      );
      expect(source.rows).toEqual([
        { payment_session_id: "malformed-payment" },
      ]);
      expect((await aggregateRows()).rows).toEqual([]);
    });

    test("rejects contradictory terminal source facts", async () => {
      await insertProcessedRow({
        attendeeId: 42,
        failureData: await encrypt('{"error":"failed"}'),
      });
      await expect(runMigration()).rejects.toThrow(
        "cannot be both completed and failed",
      );
      expect((await aggregateRows()).rows).toEqual([]);
    });

    test("rejects a refund marker without a payment reference", async () => {
      await getDb().execute({
        args: [
          "refund-without-reference",
          PROCESSED_AT,
          "2026-07-25T10:05:00.000Z",
        ],
        sql: `INSERT INTO processed_payments
          (payment_session_id, processed_at, provider_refunded_at)
          VALUES (?, ?, ?)`,
      });

      await expect(runMigration()).rejects.toThrow(
        "provider refund requires a payment reference",
      );
      expect((await aggregateRows()).rows).toEqual([]);
    });

    test("keeps the source when a case insert is skipped", async () => {
      await insertProcessedRow();
      await getDb().execute(`CREATE TRIGGER skip_legacy_payment_case
        BEFORE INSERT ON payment_cases
        WHEN NEW.payment_id LIKE 'legacy:%'
        BEGIN SELECT RAISE(IGNORE); END`);
      await expect(runMigration()).rejects.toThrow("was not copied exactly");
      await expectProcessedSourceKept();
    });

    test("refuses a source change while verified evidence is being copied", async () => {
      await insertProcessedRow();
      await getDb().execute(`CREATE TRIGGER change_legacy_payment_source
        AFTER INSERT ON payment_cases
        WHEN NEW.payment_id LIKE 'legacy:%'
        BEGIN
          UPDATE processed_payments
             SET processed_at = '2026-07-25T10:01:00.000Z'
           WHERE payment_session_id = 'one-processed-payment';
        END`);
      await expect(runMigration()).rejects.toThrow(
        "legacy payment source is closed",
      );

      const source = await getDb().execute(
        "SELECT processed_at FROM processed_payments",
      );
      expect(source.rows).toEqual([{ processed_at: PROCESSED_AT }]);
    });

    test("does not drain a source row over conflicting copied evidence", async () => {
      await insertProcessedRow();
      await getDb().execute(`CREATE TRIGGER change_copied_payment_case
        AFTER INSERT ON payment_cases
        WHEN NEW.payment_id LIKE 'legacy:%'
        BEGIN
          UPDATE payment_cases SET reason = 'different-evidence'
          WHERE id = NEW.id;
        END`);

      await expect(runMigration()).rejects.toThrow("was not copied exactly");

      await expectProcessedSourceKept();
    });
  },
);
