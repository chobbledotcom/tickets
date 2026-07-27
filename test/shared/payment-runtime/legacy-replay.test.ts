import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { encrypt } from "#shared/crypto/encryption.ts";
import { getDb } from "#shared/db/client.ts";
import {
  type PaymentReconcileOutcome,
  reconcilePayment,
} from "#shared/payment-runtime/process.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import {
  restoreLegacyPaymentSources,
  runMigration,
  seedLegacyPaidAttendee,
} from "#test/shared/db/migrations/payment-aggregate-test-utils.ts";
import { SESSION_RESOURCE } from "#test/shared/db/payments/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { completePayment, paymentProviderRead } from "./fixtures.ts";

const PROVIDERS = [
  {
    provider: "stripe" as const,
    resource: {
      id: "legacy-stripe-session",
      kind: "stripe_checkout_session" as const,
      provider: "stripe" as const,
    },
    runtime: stripePaymentProvider,
  },
  {
    provider: "square" as const,
    resource: {
      id: "legacy-square-order",
      kind: "square_order" as const,
      provider: "square" as const,
    },
    runtime: squarePaymentProvider,
  },
  {
    provider: "sumup" as const,
    resource: {
      id: "legacy-sumup-checkout",
      kind: "sumup_checkout" as const,
      provider: "sumup" as const,
    },
    runtime: sumupPaymentProvider,
  },
];

const seedCompleted = async (entry: (typeof PROVIDERS)[number]) => {
  const tickets = await encrypt("legacy-ticket");
  await seedLegacyPaidAttendee();
  await getDb().batch(
    [
      {
        args: [
          entry.resource.id,
          42,
          entry.provider,
          tickets,
          "2026-07-25T10:00:00.000Z",
        ],
        sql: `INSERT INTO checkout_stages
          (payment_session_id, attendee_id, provider, ticket_tokens, state,
           created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
      },
      {
        args: [entry.resource.id, 42, "2026-07-25T10:01:00.000Z", tickets],
        sql: `INSERT INTO processed_payments
          (payment_session_id, attendee_id, processed_at, ticket_tokens)
          VALUES (?, ?, ?, ?)`,
      },
      ...(entry.provider === "sumup"
        ? [
            {
              args: [
                "legacy-sumup-reference-index",
                "wk:1:legacy-key",
                "enc:1:legacy-metadata",
                entry.resource.id,
                "2026-07-25T10:00:30.000Z",
              ],
              sql: `INSERT INTO sumup_checkouts
                (reference_index, wrapped_key, metadata, sumup_id, created_at)
                VALUES (?, ?, ?, ?, ?)`,
            },
          ]
        : []),
    ],
    "write",
  );
  await runMigration();
};

describeWithEnv("legacy payment replay", { db: true }, () => {
  beforeEach(restoreLegacyPaymentSources);

  for (const entry of PROVIDERS) {
    test(`replays a completed migrated ${entry.provider} payment without another effect`, async () => {
      await seedCompleted(entry);
      using read = stub(entry.runtime, "readPayment", () => {
        throw new Error("A migrated terminal payment must not be read again");
      });
      using refund = stub(entry.runtime, "refundCharge", () => {
        throw new Error(
          "A migrated terminal payment must not be refunded again",
        );
      });
      let fulfilments = 0;

      const outcome = await reconcilePayment(
        entry.provider,
        { kind: "provider", resource: entry.resource },
        () => {
          fulfilments++;
          throw new Error(
            "A migrated terminal payment must not be fulfilled again",
          );
        },
      );

      expect(outcome).toMatchObject({ replayed: true, status: "completed" });
      expect(read.calls).toHaveLength(0);
      expect(refund.calls).toHaveLength(0);
      expect(fulfilments).toBe(0);
      const sessions = await getDb().execute(
        "SELECT origin, attendee_id FROM payment_sessions",
      );
      expect(sessions.rows).toEqual([{ attendee_id: 42, origin: "legacy" }]);
    });
  }

  for (const terminal of [
    {
      error: "The booking sold out.",
      provider: "stripe" as const,
      providerRefundedAt: "",
      reference: "",
    },
    {
      error: "The payment was returned.",
      provider: "square" as const,
      providerRefundedAt: "2026-07-25T10:02:00.000Z",
      reference: "hyb:1:legacy-provider-reference",
    },
  ]) {
    test(`replays a migrated ${terminal.provider} ${terminal.providerRefundedAt ? "refund" : "failure"}`, async () => {
      const runtime =
        terminal.provider === "stripe"
          ? stripePaymentProvider
          : squarePaymentProvider;
      const resource =
        terminal.provider === "stripe"
          ? SESSION_RESOURCE
          : {
              id: "legacy-failed-square-order",
              kind: "square_order" as const,
              provider: "square" as const,
            };
      const failure = await encrypt(
        JSON.stringify({ error: terminal.error, refunded: true, status: 409 }),
      );
      await getDb().batch(
        [
          {
            args: [
              resource.id,
              42,
              terminal.provider,
              await encrypt("legacy-ticket"),
              "2026-07-25T10:00:00.000Z",
            ],
            sql: `INSERT INTO checkout_stages
              (payment_session_id, attendee_id, provider, ticket_tokens, state,
               created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
          },
          {
            args: [
              resource.id,
              "2026-07-25T10:01:00.000Z",
              failure,
              terminal.reference,
              terminal.providerRefundedAt,
            ],
            sql: `INSERT INTO processed_payments
              (payment_session_id, processed_at, failure_data,
               payment_reference, provider_refunded_at)
              VALUES (?, ?, ?, ?, ?)`,
          },
        ],
        "write",
      );
      await runMigration();
      using read = stub(runtime, "readPayment", () => {
        throw new Error("A migrated terminal payment must not be read again");
      });
      using refund = stub(runtime, "refundCharge", () => {
        throw new Error(
          "A migrated terminal payment must not be refunded again",
        );
      });
      let fulfilments = 0;

      const outcome = await reconcilePayment(
        terminal.provider,
        { kind: "provider", resource },
        () => {
          fulfilments++;
          throw new Error("A migrated terminal payment must not be fulfilled");
        },
      );

      expect(outcome.status).toBe("fulfilled");
      if (outcome.status !== "fulfilled") throw new Error("Expected replay");
      expect(outcome.result).toMatchObject({
        error: terminal.error,
        status: 409,
        success: false,
      });
      expect(read.calls).toHaveLength(0);
      expect(refund.calls).toHaveLength(0);
      expect(fulfilments).toBe(0);
      expect(
        Number(
          (
            await getDb().execute(
              "SELECT COUNT(*) AS count FROM payment_sessions",
            )
          ).rows[0]?.count,
        ),
      ).toBe(1);
    });
  }

  test("binds an unowned migrated session on its first signed callback", async () => {
    const tickets = await encrypt("legacy-ticket");
    await seedLegacyPaidAttendee();
    await getDb().execute({
      args: [SESSION_RESOURCE.id, 42, "2026-07-25T10:01:00.000Z", tickets],
      sql: `INSERT INTO processed_payments
        (payment_session_id, attendee_id, processed_at, ticket_tokens)
        VALUES (?, ?, ?, ?)`,
    });
    await runMigration();
    using read = stub(stripePaymentProvider, "readPayment", () =>
      Promise.resolve(
        paymentProviderRead({
          ownership: {
            localPaymentId: "adopted:stripe:cs_test_1",
            method: "signed",
            signature: "legacy-signed-proof",
          },
        }),
      ),
    );

    const outcome = await reconcilePayment(
      "stripe",
      {
        kind: "provider",
        resource: SESSION_RESOURCE,
      },
      completePayment,
    );

    expect(outcome).toMatchObject({ replayed: true, status: "completed" });
    expect(read.calls).toHaveLength(1);
    const sessions = await getDb().execute(
      "SELECT origin, provider FROM payment_sessions",
    );
    expect(sessions.rows).toEqual([{ origin: "legacy", provider: "stripe" }]);
  });

  test("records a required-action case for an ambiguous legacy session", async () => {
    const sharedCheckoutId = "ambiguous-sumup-checkout";
    await getDb().batch(
      ["first", "second"].map((suffix) => ({
        args: [
          `reference-${suffix}`,
          `wk:1:key-${suffix}`,
          `enc:1:metadata-${suffix}`,
          sharedCheckoutId,
          "2026-07-25T10:00:00.000Z",
        ],
        sql: `INSERT INTO sumup_checkouts
          (reference_index, wrapped_key, metadata, sumup_id, created_at)
          VALUES (?, ?, ?, ?, ?)`,
      })),
      "write",
    );
    await runMigration();
    using read = stub(sumupPaymentProvider, "readPayment", () => {
      throw new Error("An ambiguous mapping must not read one candidate");
    });

    const outcome: PaymentReconcileOutcome = await reconcilePayment(
      "sumup",
      {
        kind: "provider",
        resource: {
          id: sharedCheckoutId,
          kind: "sumup_checkout",
          provider: "sumup",
        },
      },
      completePayment,
    );

    expect(outcome.status).toBe("conflict");
    expect(read.calls).toHaveLength(0);
    const cases = await getDb().execute(`SELECT reason, state
      FROM payment_cases WHERE reason = 'legacy_mapping_ambiguous'
      ORDER BY payment_id`);
    expect(cases.rows).toEqual([
      { reason: "legacy_mapping_ambiguous", state: "needs_action" },
      { reason: "legacy_mapping_ambiguous", state: "needs_action" },
    ]);
  });
});
