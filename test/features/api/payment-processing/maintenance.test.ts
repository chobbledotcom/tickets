/* jscpd:ignore-start */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { recoverCheckoutStages } from "#routes/api/payment-processing/maintenance.ts";
import {
  beginCheckoutStageRefund,
  loadCheckoutStageByPaymentSession,
} from "#shared/db/checkout-stages.ts";
import { execute, queryAll } from "#shared/db/client.ts";
import { reserveSession } from "#shared/db/processed-payments.ts";
import type { MaintenanceTaskContext } from "#shared/maintenance/definition.ts";
import type {
  BookingIntent,
  ValidatedPaymentSession,
} from "#shared/payments.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  getSubrequestRemaining,
  runWithSubrequestBudget,
  withSubrequestAllowance,
} from "#shared/subrequest-budget.ts";
import {
  intentFor,
  stageSession,
} from "#test/features/api/payment-processing/staged-runtime.helpers.ts";
import { attendeeExists } from "#test/shared/db/prune/helpers.ts";
import { testCheckoutRefund } from "#test-utils/checkout-stages.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { signedMeta } from "#test-utils/factories.ts";

/* jscpd:ignore-end */

const paidProviderSession = (
  sessionId: string,
  intent: BookingIntent,
): ValidatedPaymentSession => {
  const amountTotal = intent.items.reduce((total, item) => total + item.p, 0);
  return {
    amountTotal,
    id: sessionId,
    metadata: signedMeta(
      {
        email: intent.email,
        items: JSON.stringify(intent.items),
        modifiers: JSON.stringify(intent.modifiers ?? []),
        name: intent.name,
        phone: intent.phone,
      },
      amountTotal,
    ),
    paymentReference: `payment-${sessionId}`,
    paymentStatus: "paid",
  };
};

const due = (sessionId: string): Promise<unknown> =>
  execute(
    "UPDATE checkout_stages SET next_attempt_at = 0 WHERE payment_session_id = ?",
    [sessionId],
  );

const runRecovery = async (
  options: {
    database?: number;
    deadline?: number;
    external?: number;
    total?: number;
  } = {},
): Promise<{ followUps: number[] }> => {
  const followUps: number[] = [];
  await runWithSubrequestBudget(() =>
    withSubrequestAllowance(
      {
        database: options.database ?? 23,
        external: options.external ?? 9,
        total: options.total ?? 32,
      },
      () =>
        recoverCheckoutStages({
          budget: { remaining: getSubrequestRemaining },
          checkpoint: null,
          completeTask: () => {},
          deadline: options.deadline ?? Date.now() + 20_000,
          requestFollowUp: (afterMs = 60_000) => followUps.push(afterMs),
          setCheckpoint: () => {},
        } satisfies MaintenanceTaskContext),
    ),
  );
  return { followUps };
};

const stageAttempt = async (
  sessionId: string,
): Promise<{ attempt_count: number; state: string }> =>
  (
    await queryAll<{ attempt_count: number; state: string }>(
      "SELECT attempt_count, state FROM checkout_stages WHERE payment_session_id = ?",
      [sessionId],
    )
  )[0]!;

describeWithEnv(
  "payment processing > scheduled stage recovery",
  { db: true },
  () => {
    test("processes a paid pending stage after provider closure discovers payment", async () => {
      const listing = await createTestListing({
        maxAttendees: 5,
        unitPrice: 1000,
      });
      const intent = intentFor(listing.id);
      const attendeeId = await stageSession("scheduled-paid", intent);
      await due("scheduled-paid");
      using close = stub(stripePaymentProvider, "closeCheckout", () =>
        Promise.resolve("paid" as const),
      );
      using retrieve = stub(stripePaymentProvider, "retrieveSession", () =>
        Promise.resolve(paidProviderSession("scheduled-paid", intent)),
      );

      const first = await runRecovery();
      expect(
        await loadCheckoutStageByPaymentSession("scheduled-paid"),
      ).toMatchObject({ state: "paid" });
      expect(first.followUps).toHaveLength(1);

      await runRecovery();
      expect(
        await loadCheckoutStageByPaymentSession("scheduled-paid"),
      ).toBeNull();
      expect(await attendeeExists(attendeeId)).toBe(true);
      expect(
        await queryAll(
          "SELECT quantity FROM listing_attendees WHERE attendee_id = ?",
          [attendeeId],
        ),
      ).toEqual([{ quantity: 1 }]);
      expect(close.calls).toHaveLength(1);
      expect(retrieve.calls).toHaveLength(1);
    });

    test("finishes a refunding stage without another callback", async () => {
      const listing = await createTestListing({ unitPrice: 1000 });
      const intent = intentFor(listing.id);
      const attendeeId = await stageSession("scheduled-refund", intent);
      await beginCheckoutStageRefund(
        "scheduled-refund",
        testCheckoutRefund("capacity_full"),
      );
      await due("scheduled-refund");
      using retrieve = stub(stripePaymentProvider, "retrieveSession", () =>
        Promise.resolve(paidProviderSession("scheduled-refund", intent)),
      );
      using refund = stub(stripePaymentProvider, "refundPayment", () =>
        Promise.resolve("refunded" as const),
      );

      await runRecovery();

      expect(
        await loadCheckoutStageByPaymentSession("scheduled-refund"),
      ).toBeNull();
      expect(await attendeeExists(attendeeId)).toBe(false);
      expect(refund.calls).toHaveLength(1);
      expect(retrieve.calls).toHaveLength(1);
      expect(
        await queryAll("SELECT memo FROM transfers WHERE kind = 'refund_cash'"),
      ).toEqual([{ memo: "capacity_full" }]);
    });

    test("refunds a paid recovered stage that can no longer be booked", async () => {
      const listing = await createTestListing({ unitPrice: 1000 });
      const intent = intentFor(listing.id);
      const attendeeId = await stageSession("scheduled-paid-refund", intent);
      await due("scheduled-paid-refund");
      using close = stub(stripePaymentProvider, "closeCheckout", () =>
        Promise.resolve("paid" as const),
      );
      using retrieve = stub(stripePaymentProvider, "retrieveSession", () =>
        Promise.resolve(paidProviderSession("scheduled-paid-refund", intent)),
      );
      using refund = stub(stripePaymentProvider, "refundPayment", () =>
        Promise.resolve("refunded" as const),
      );

      await runRecovery();
      await deactivateTestListing(listing.id);
      await runRecovery();

      expect(
        await loadCheckoutStageByPaymentSession("scheduled-paid-refund"),
      ).toBeNull();
      expect(await attendeeExists(attendeeId)).toBe(false);
      expect(close.calls).toHaveLength(1);
      expect(retrieve.calls).toHaveLength(1);
      expect(refund.calls).toHaveLength(1);
    });

    test("moves failed oldest stages aside before processing a later stage", async () => {
      const listing = await createTestListing({ unitPrice: 1000 });
      const intent = intentFor(listing.id);
      const sessions = [
        "failed-1",
        "failed-2",
        "failed-3",
        "failed-4",
        "later",
      ];
      const attendeeIds = await Promise.all(
        sessions.map(async (sessionId) => {
          const attendeeId = await stageSession(sessionId, intent);
          await due(sessionId);
          return attendeeId;
        }),
      );
      using close = stub(
        stripePaymentProvider,
        "closeCheckout",
        ({ sessionId }) =>
          sessionId === "later"
            ? Promise.resolve("closed" as const)
            : Promise.reject(new Error(`provider failed for ${sessionId}`)),
      );

      await runRecovery();

      expect(await attendeeExists(attendeeIds.at(-1)!)).toBe(false);
      expect(close.calls).toHaveLength(sessions.length);
      const failed = await queryAll<{
        attempt_count: number;
        next_attempt_at: number;
        payment_session_id: string;
      }>(
        `SELECT payment_session_id, attempt_count, next_attempt_at
         FROM checkout_stages ORDER BY payment_session_id`,
      );
      expect(
        failed.map(({ attempt_count, payment_session_id }) => ({
          attempt_count,
          payment_session_id,
        })),
      ).toEqual(
        sessions.slice(0, -1).map((payment_session_id) => ({
          attempt_count: 1,
          payment_session_id,
        })),
      );
      expect(
        failed.every(({ next_attempt_at }) => next_attempt_at > Date.now()),
      ).toBe(true);
    });

    test("defers a closed stage that a payment callback already claimed", async () => {
      const listing = await createTestListing({ unitPrice: 1000 });
      const intent = intentFor(listing.id);
      const attendeeId = await stageSession("scheduled-claimed", intent);
      await due("scheduled-claimed");
      await reserveSession("scheduled-claimed");
      using close = stub(stripePaymentProvider, "closeCheckout", () =>
        Promise.resolve("closed" as const),
      );

      await runRecovery();

      expect(await stageAttempt("scheduled-claimed")).toEqual({
        attempt_count: 1,
        state: "pending",
      });
      expect(await attendeeExists(attendeeId)).toBe(true);
      expect(close.calls).toHaveLength(1);
    });

    test("defers a paid stage while its provider session cannot be read", async () => {
      const listing = await createTestListing({ unitPrice: 1000 });
      const intent = intentFor(listing.id);
      await stageSession("scheduled-unread", intent);
      await execute(
        "UPDATE checkout_stages SET state = 'paid', next_attempt_at = 0 WHERE payment_session_id = ?",
        ["scheduled-unread"],
      );
      using retrieve = stub(stripePaymentProvider, "retrieveSession", () =>
        Promise.resolve(null),
      );

      await runRecovery();

      expect(await stageAttempt("scheduled-unread")).toEqual({
        attempt_count: 1,
        state: "paid",
      });
      expect(retrieve.calls).toHaveLength(1);
    });

    test("defers a paid stage whose recovered session has no valid proof", async () => {
      const listing = await createTestListing({ unitPrice: 1000 });
      const intent = intentFor(listing.id);
      await stageSession("scheduled-invalid", intent);
      await execute(
        "UPDATE checkout_stages SET state = 'paid', next_attempt_at = 0 WHERE payment_session_id = ?",
        ["scheduled-invalid"],
      );
      const session = paidProviderSession("scheduled-invalid", intent);
      using _retrieve = stub(stripePaymentProvider, "retrieveSession", () =>
        Promise.resolve({
          ...session,
          metadata: { ...session.metadata, _price: "invalid" },
        }),
      );

      await runRecovery();

      expect(await stageAttempt("scheduled-invalid")).toEqual({
        attempt_count: 1,
        state: "paid",
      });
    });

    test("keeps a pending provider refund in the recovery queue", async () => {
      const listing = await createTestListing({ unitPrice: 1000 });
      const intent = intentFor(listing.id);
      await stageSession("scheduled-pending-refund", intent);
      await beginCheckoutStageRefund(
        "scheduled-pending-refund",
        testCheckoutRefund("capacity_full"),
      );
      await due("scheduled-pending-refund");
      using _retrieve = stub(stripePaymentProvider, "retrieveSession", () =>
        Promise.resolve(
          paidProviderSession("scheduled-pending-refund", intent),
        ),
      );
      using refund = stub(stripePaymentProvider, "refundPayment", () =>
        Promise.resolve("pending" as const),
      );

      await runRecovery();

      expect(await stageAttempt("scheduled-pending-refund")).toEqual({
        attempt_count: 1,
        state: "refunding",
      });
      expect(refund.calls).toHaveLength(1);
    });

    test("starts no checkout work past its deadline or without its budget", async () => {
      const listing = await createTestListing({ unitPrice: 1000 });
      const intent = intentFor(listing.id);
      await stageSession("scheduled-wait", intent);
      await due("scheduled-wait");
      using close = stub(stripePaymentProvider, "closeCheckout", () =>
        Promise.resolve("closed" as const),
      );

      await runRecovery({ deadline: Date.now() - 1 });
      await runRecovery({ database: 2, external: 0, total: 2 });

      expect(await stageAttempt("scheduled-wait")).toEqual({
        attempt_count: 0,
        state: "pending",
      });
      expect(close.calls).toHaveLength(0);
    });
  },
);
