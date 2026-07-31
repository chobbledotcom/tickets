import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import { encrypt } from "#shared/crypto/encryption.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { getDb, resultRows } from "#shared/db/client.ts";
import { paymentStoredJson } from "#shared/db/payments/codecs.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  restoreLegacyPaymentSources,
  runMigration,
  seedLegacyPaidAttendee,
} from "./payment-aggregate-test-utils.ts";

describeWithEnv(
  "db > migrations > payment aggregate legacy runtime",
  { db: true },
  () => {
    beforeEach(restoreLegacyPaymentSources);

    test("preserves a completed staged payment and its refundable reference", async () => {
      await seedLegacyPaidAttendee();
      const ticketTokens = await encrypt("ticket-one+ticket-two");
      const paymentReference = "hyb:1:key:iv:legacy-provider-reference";
      await getDb().batch(
        [
          {
            args: [
              "shared-session",
              42,
              "2026-07-25T10:01:00.000Z",
              ticketTokens,
              paymentReference,
              "2026-07-25T10:02:00.000Z",
            ],
            sql: `INSERT INTO processed_payments
              (payment_session_id, attendee_id, processed_at, ticket_tokens,
               payment_reference, provider_refunded_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
          },
          {
            args: [
              "shared-session",
              42,
              "stripe",
              ticketTokens,
              "pending",
              "2026-07-25T10:00:00.000Z",
            ],
            sql: `INSERT INTO checkout_stages
              (payment_session_id, attendee_id, provider, ticket_tokens, state,
               created_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
          },
        ],
        "write",
      );

      await runMigration();

      const sessions = await getDb().execute(`SELECT provider, state,
          result_state, result, ticket_state, ticket_tokens, completion_state,
          checkout_create
        FROM payment_sessions WHERE origin = 'legacy'`);
      expect(sessions.rows).toEqual([
        {
          checkout_create: null,
          completion_state: "legacy_unknown",
          provider: "stripe",
          result: null,
          result_state: "succeeded",
          state: "completed",
          ticket_state: "ready",
          ticket_tokens: ticketTokens,
        },
      ]);
      const charges = await getDb().execute(`SELECT origin, provider,
          resource_kind, provider_reference, reference_index, captured_amount,
          currency, refunded_amount, refund_state, provider_refunded_at
        FROM payment_charges`);
      expect(charges.rows).toEqual([
        {
          captured_amount: null,
          currency: null,
          origin: "legacy",
          provider: null,
          provider_reference: paymentReference,
          provider_refunded_at: "2026-07-25T10:02:00.000Z",
          reference_index: null,
          refund_state: "unknown",
          refunded_amount: null,
          resource_kind: null,
        },
      ]);
      const cases = await getDb().execute(
        "SELECT reason, evidence FROM payment_cases ORDER BY reason",
      );
      expect(cases.rows.map((row) => row.reason)).toEqual([
        "legacy_provider_session",
        "legacy_provider_unknown",
        "legacy_refund_amount_unknown",
      ]);
      const evidence = await Promise.all(
        resultRows<{ evidence: EnvKeyEncrypted }>(cases).map((row) =>
          paymentStoredJson.caseEvidence.open(
            row.evidence,
            "test case evidence",
          ),
        ),
      );
      expect(
        evidence.map((item) =>
          "providerRefundedAt" in item ? item.providerRefundedAt : null,
        ),
      ).toEqual(["", "2026-07-25T10:02:00.000Z", "2026-07-25T10:02:00.000Z"]);
      const sourceCounts = await getDb().execute(`SELECT
        (SELECT COUNT(*) FROM processed_payments) AS processed,
        (SELECT COUNT(*) FROM checkout_stages) AS stages`);
      expect(sourceCounts.rows[0]).toEqual({ processed: 0, stages: 0 });
    });

    test("preserves a terminal failure ciphertext as its failed result", async () => {
      const failureData = await encrypt(
        '{"error":"sold out","refunded":true,"status":409}',
      );
      await getDb().execute({
        args: ["failed-session", "2026-07-25T10:00:00.000Z", failureData],
        sql: `INSERT INTO processed_payments
          (payment_session_id, processed_at, failure_data)
          VALUES (?, ?, ?)`,
      });

      await runMigration();

      const result = await getDb().execute(`SELECT state, result_state, result,
        completion_state FROM payment_sessions WHERE origin = 'legacy'`);
      expect(result.rows).toEqual([
        {
          completion_state: "none",
          result: failureData,
          result_state: "failed",
          state: "failed",
        },
      ]);
    });

    test("keeps an unresolved reservation processing with one action case", async () => {
      await getDb().execute(`INSERT INTO processed_payments
        (payment_session_id, processed_at)
        VALUES ('processing-session', '2026-07-25T10:00:00.000Z')`);

      await runMigration();

      const session = await getDb().execute(`SELECT state, result_state,
        ticket_state, completion_state FROM payment_sessions`);
      expect(session.rows).toEqual([
        {
          completion_state: "none",
          result_state: "none",
          state: "processing",
          ticket_state: "none",
        },
      ]);
      const cases = await getDb().execute("SELECT reason FROM payment_cases");
      expect(cases.rows).toEqual([{ reason: "legacy_lifecycle_unknown" }]);
    });

    test("does not turn a provider refund marker into completed money", async () => {
      await getDb().execute(`INSERT INTO processed_payments
        (payment_session_id, processed_at, payment_reference,
         provider_refunded_at)
        VALUES ('refund-marker', '2026-07-25T10:00:00.000Z',
          'hyb:1:key:iv:legacy-reference', '2026-07-25T10:05:00.000Z')`);

      await runMigration();

      const session = await getDb().execute(`SELECT state, result_state,
        completion_state FROM payment_sessions`);
      expect(session.rows).toEqual([
        {
          completion_state: "none",
          result_state: "none",
          state: "processing",
        },
      ]);
      const charge = await getDb().execute(`SELECT refund_state,
        refunded_amount, provider_refunded_at FROM payment_charges`);
      expect(charge.rows).toEqual([
        {
          provider_refunded_at: "2026-07-25T10:05:00.000Z",
          refund_state: "unknown",
          refunded_amount: null,
        },
      ]);
      const cases = await getDb().execute(
        "SELECT reason FROM payment_cases ORDER BY reason",
      );
      expect(cases.rows).toEqual([
        { reason: "legacy_lifecycle_unknown" },
        { reason: "legacy_provider_unknown" },
        { reason: "legacy_refund_amount_unknown" },
      ]);
    });

    test("joins a SumUp local stage and provider outcome into one payment", async () => {
      await seedLegacyPaidAttendee();
      const [ticketTokens, metadata] = await Promise.all([
        encrypt("ticket-one"),
        encrypt('{"name":"Legacy customer"}'),
      ]);
      const localReference = "sumup-local-reference";
      const providerCheckoutId = "sumup-checkout-1";
      await getDb().batch(
        [
          {
            args: [
              localReference,
              42,
              "sumup",
              ticketTokens,
              "pending",
              "2026-07-25T10:00:00.000Z",
            ],
            sql: `INSERT INTO checkout_stages
              (payment_session_id, attendee_id, provider, ticket_tokens, state,
                created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          },
          {
            args: [
              providerCheckoutId,
              42,
              "2026-07-25T10:02:00.000Z",
              ticketTokens,
            ],
            sql: `INSERT INTO processed_payments
              (payment_session_id, attendee_id, processed_at, ticket_tokens)
              VALUES (?, ?, ?, ?)`,
          },
          {
            args: [
              await hmacHash(localReference),
              "wk:1:legacy-wrapped-key",
              metadata,
              providerCheckoutId,
              "2026-07-25T10:01:00.000Z",
            ],
            sql: `INSERT INTO sumup_checkouts
              (reference_index, wrapped_key, metadata, sumup_id, created_at)
              VALUES (?, ?, ?, ?, ?)`,
          },
        ],
        "write",
      );

      await runMigration();

      const sessions = await getDb().execute(
        "SELECT provider, state, ticket_tokens, legacy_runtime FROM payment_sessions",
      );
      expect(sessions.rows).toHaveLength(1);
      expect(sessions.rows[0]).toMatchObject({
        provider: "sumup",
        state: "completed",
        ticket_tokens: ticketTokens,
      });
      const stored = resultRows<{ legacy_runtime: EnvKeyEncrypted }>(
        sessions,
      )[0];
      if (stored === undefined) throw new Error("Expected SumUp runtime");
      const runtime = await paymentStoredJson.legacyRuntime.open(
        stored.legacy_runtime,
        "test SumUp legacy runtime",
      );
      expect(runtime.checkoutStage?.paymentSessionId).toBe(localReference);
      expect(runtime.processedPayment?.paymentSessionId).toBe(
        providerCheckoutId,
      );
      expect(runtime.sumupCheckout).toEqual({
        createdAt: "2026-07-25T10:01:00.000Z",
        metadata,
        referenceIndex: await hmacHash(localReference),
        sumupId: providerCheckoutId,
        wrappedKey: "wk:1:legacy-wrapped-key",
      });
    });

    test("rejects an unknown checkout stage state without draining it", async () => {
      await getDb().execute({
        args: [await encrypt("ticket-one")],
        sql: `INSERT INTO checkout_stages
          (payment_session_id, attendee_id, provider, ticket_tokens, state,
           created_at) VALUES ('unknown-state', 42, 'stripe', ?, 'mystery',
           '2026-07-25T10:00:00.000Z')`,
      });

      await expect(runMigration()).rejects.toThrow(
        'Expected ("pending" | "refunding")',
      );
      const source = await getDb().execute("SELECT state FROM checkout_stages");
      expect(source.rows).toEqual([{ state: "mystery" }]);
      expect(
        (await getDb().execute("SELECT id FROM payment_sessions")).rows,
      ).toEqual([]);
    });

    test("rejects an unknown checkout provider without draining it", async () => {
      await getDb().execute({
        args: [await encrypt("ticket-one")],
        sql: `INSERT INTO checkout_stages
          (payment_session_id, attendee_id, provider, ticket_tokens, state,
           created_at) VALUES ('unknown-provider', 42, 'mystery', ?, 'pending',
           '2026-07-25T10:00:00.000Z')`,
      });

      await expect(runMigration()).rejects.toThrow(
        'Expected ("stripe" | "square" | "sumup")',
      );
      const source = await getDb().execute(
        "SELECT provider FROM checkout_stages",
      );
      expect(source.rows).toEqual([{ provider: "mystery" }]);
      expect(
        (await getDb().execute("SELECT id FROM payment_sessions")).rows,
      ).toEqual([]);
    });

    test("keeps a source row when its aggregate session is not inserted", async () => {
      await getDb().execute(`INSERT INTO processed_payments
        (payment_session_id, processed_at)
        VALUES ('missing-target', '2026-07-25T10:00:00.000Z')`);
      await getDb().execute(`CREATE TRIGGER skip_legacy_payment_session
        BEFORE INSERT ON payment_sessions
        WHEN NEW.origin = 'legacy'
        BEGIN SELECT RAISE(IGNORE); END`);

      await expect(runMigration()).rejects.toThrow("was not copied exactly");

      const source = await getDb().execute(
        "SELECT payment_session_id FROM processed_payments",
      );
      expect(source.rows).toEqual([{ payment_session_id: "missing-target" }]);
    });

    test("drains or refuses a legacy row inserted while the source is draining", async () => {
      await getDb().execute(`INSERT INTO processed_payments
        (payment_session_id, processed_at)
        VALUES ('first-row', '2026-07-25T10:00:00.000Z')`);
      await getDb().execute(`CREATE TRIGGER inject_legacy_payment_during_drain
        AFTER DELETE ON processed_payments
        WHEN OLD.payment_session_id = 'first-row'
        BEGIN
          INSERT INTO processed_payments (payment_session_id, processed_at)
          VALUES ('concurrent-row', '2026-07-25T10:01:00.000Z');
        END`);

      let refused = false;
      try {
        await runMigration();
      } catch (error) {
        refused = String(error).includes("legacy payment source");
      }
      const remaining = await getDb().execute(
        "SELECT payment_session_id FROM processed_payments ORDER BY payment_session_id",
      );

      expect(refused || remaining.rows.length === 0).toBe(true);
    });
  },
);
