import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { executeBatch, getDb } from "#shared/db/client.ts";
import { paymentChargeStatements } from "#shared/db/payments/charges.ts";
import { createPaymentSession } from "#shared/db/payments/sessions.ts";
import { getPaymentRefundTargets } from "#shared/payment-runtime/refund-targets.ts";
import {
  PAYMENT_TIME,
  paymentSessionInput,
} from "#test/shared/db/payments/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { recordQueries } from "#test-utils/record-queries.ts";

const PAYMENT_COUNT = 51;
const ATTENDEE_IDS = [42, 43] as const;
const payments = Array.from({ length: PAYMENT_COUNT }, (_, index) => ({
  attendeeId: index % 2 === 0 ? ATTENDEE_IDS[0] : ATTENDEE_IDS[1],
  createdAt: PAYMENT_TIME + index,
  id: `target-payment-${String(index).padStart(2, "0")}`,
}));

const seedPayments = async (): Promise<void> => {
  const seedId = "target-payment-seed";
  await createPaymentSession(paymentSessionInput(seedId, null), PAYMENT_TIME);
  await getDb().execute(
    `WITH RECURSIVE numbers(value) AS (
       VALUES (0)
       UNION ALL SELECT value + 1 FROM numbers WHERE value + 1 < ?
     )
     INSERT INTO payment_sessions
       (id, origin, provider, mode, account_id, session_resource,
        session_reference_index, expected_amount, expected_currency,
        booking_intent, state, revision, created_at, updated_at,
        next_reconcile_at, attendee_id, result_state, result, ticket_state,
        ticket_tokens, completion_state, completion, legacy_runtime)
     SELECT printf('target-payment-%02d', value), origin, provider, mode,
            account_id, NULL, NULL, expected_amount, expected_currency,
            booking_intent, 'created', 1, ? + value, ? + value,
            NULL, CASE value % 2 WHEN 0 THEN ? ELSE ? END,
            'none', NULL, 'none', NULL, 'none', NULL, NULL
       FROM payment_sessions, numbers
      WHERE id = ?`,
    [
      PAYMENT_COUNT,
      PAYMENT_TIME,
      PAYMENT_TIME,
      ATTENDEE_IDS[0],
      ATTENDEE_IDS[1],
      seedId,
    ],
  );
  const statements = await Promise.all(
    payments.map(({ createdAt, id }, index) => {
      const session = {
        id: `target-session-${index}`,
        kind: "stripe_checkout_session" as const,
        provider: "stripe" as const,
      };
      return paymentChargeStatements(
        id,
        session,
        [
          {
            captured: { amount: 1_000 + index, currency: "GBP" },
            confirmedRefunded: { amount: 0, currency: "GBP" },
            refunds: [],
            resource: {
              id: `target-charge-${index}`,
              kind: "stripe_payment_intent" as const,
              parentId: session.id,
              provider: "stripe" as const,
            },
          },
        ],
        createdAt,
      );
    }),
  );
  await executeBatch(statements.flat());
};

describeWithEnv("payment refund targets", { db: true }, () => {
  test("does not read the database for an empty attendee list", async () => {
    const queries: string[] = [];
    const restore = recordQueries(queries);
    try {
      expect(await getPaymentRefundTargets([])).toEqual(new Map());
    } finally {
      restore();
    }
    expect(queries).toEqual([]);
  });

  test("returns no group for an attendee without a payment", async () => {
    expect(await getPaymentRefundTargets([999])).toEqual(new Map());
  });

  test("keeps a payment with no charge as an empty target", async () => {
    const paymentId = "target-without-charge";
    await createPaymentSession(
      paymentSessionInput(paymentId, null),
      PAYMENT_TIME,
    );
    await getDb().execute(
      "UPDATE payment_sessions SET attendee_id = ? WHERE id = ?",
      [ATTENDEE_IDS[0], paymentId],
    );

    const targets = await getPaymentRefundTargets([ATTENDEE_IDS[0]]);
    expect(
      targets.get(ATTENDEE_IDS[0])?.map(({ charges, payment }) => ({
        chargeCount: charges.length,
        paymentId: payment.id,
      })),
    ).toEqual([{ chargeCount: 0, paymentId }]);
  });

  test("loads more than 50 payments in two reads with exact grouping and order", async () => {
    await seedPayments();
    const queries: string[] = [];
    const restore = recordQueries(queries);
    let targets: Awaited<ReturnType<typeof getPaymentRefundTargets>>;
    try {
      targets = await getPaymentRefundTargets(ATTENDEE_IDS);
    } finally {
      restore();
    }

    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("FROM payment_sessions");
    expect(queries[1]).toContain("FROM payment_charges");
    expect(
      Array.from(targets, ([attendeeId, values]) => ({
        attendeeId,
        charges: values.map(({ charges }) =>
          charges.map(({ paymentId }) => paymentId),
        ),
        payments: values.map(({ payment }) => payment.id),
      })),
    ).toEqual(
      ATTENDEE_IDS.map((attendeeId) => {
        const ids = payments
          .filter((payment) => payment.attendeeId === attendeeId)
          .map((payment) => payment.id);
        return {
          attendeeId,
          charges: ids.map((id) => [id]),
          payments: ids,
        };
      }),
    );
  });
});
