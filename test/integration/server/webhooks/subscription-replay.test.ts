import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { allTransfers } from "#accounting/queries.ts";
import { execute } from "#db/client.ts";
import {
  type ProcessedPayment,
  parseSessionFailure,
  releaseReservation,
  reserveSession,
} from "#db/processed-payments.ts";
import { sql } from "#db/sql.ts";
import { requireValue } from "#shared/required-value.ts";
import { stripeApi } from "#shared/stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { signedMeta } from "#test-utils/factories.ts";
import { getProcessedPayment } from "#test-utils/processed-payments.ts";
import { expectOnePairOfLegs } from "#test-utils/rejected-charge.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stripeFirstInvoice } from "#test-utils/stripe/fixtures.ts";
import { stubRefundPayment } from "#test-utils/webhooks/stripe.ts";
import {
  checkoutListingId,
  deliver,
  EXPECTED_PLACEHOLDER,
  expectActions,
  expectPlan,
  expectStatuses,
  heldAnchor,
  observedSubscription,
  placeholderOwner,
  SESSION_ID,
  startedCheckout,
  storedPlans,
  withCheckoutActions,
  withRejectedCheckout,
} from "./subscription-refund-helpers.ts";

const processed = async () =>
  requireValue(await getProcessedPayment(SESSION_ID), "Session was not stored");

const failure = async () =>
  requireValue(
    await parseSessionFailure((await processed()).failureData),
    "Stored session has no failure",
  );

const refusedCancellation = () => ({
  reason: "rejected_request" as const,
  status: "invalid" as const,
});

describeWithEnv("subscription checkout replay recovery", { db: true }, () => {
  for (const staleMarker of [false, true]) {
    test(`replays a settled rejected refund with ${staleMarker ? "a stale" : "the final"} outcome`, async () => {
      await setupStripe();
      const listingId = await checkoutListingId();
      let pending: ProcessedPayment["failureData"] | undefined;
      using cancel = stub(stripeApi, "cancelSubscription", async (id) => {
        pending = (await processed()).failureData;
        return observedSubscription(id, "canceled");
      });
      using refund = stubRefundPayment("re_settled_rejection", 2000);
      await withRejectedCheckout(
        listingId,
        "malformed charge",
        false,
        async (session) => {
          await expectStatuses(deliver, 400);
          expect(await failure()).toMatchObject({ refunded: true });
          expect((await heldAnchor()).held).toBeNull();
          const ledger = await allTransfers();
          await expectOnePairOfLegs(SESSION_ID);
          if (staleMarker) {
            // Replay the crash window after settlement but before the final
            // outcome write, using bytes captured from this real delivery.
            await execute(
              sql`UPDATE processed_payments SET failure_data = ${requireValue(pending, "Pending outcome was not captured")} WHERE payment_session_id = ${SESSION_ID}`,
            );
            expect((await failure()).refunded).not.toBe(true);
          }

          await expectStatuses(deliver, 400);
          expect(await failure()).toMatchObject({ refunded: true });
          // A later readable provider response must tell the buyer the refund
          // completed, not replay the conservative refund-pending message.
          session.amount_total = 2000;
          const response = await deliver();
          expect(response.status).toBe(200);
          expect(await response.text()).toContain("refunded");
          expectActions(cancel, refund, 1, 1);
          await expectPlan(listingId);
          expect(await allTransfers()).toEqual(ledger);
        },
      );
    });
  }

  test("fails each delivery while a paid checkout names no charge, then books it", async () => {
    await setupStripe();
    const listingId = await checkoutListingId();
    const started = startedCheckout(listingId);
    started.invoice = stripeFirstInvoice();
    started.invoice.payments.data = [];
    await withCheckoutActions(
      started,
      (id) => Promise.resolve(observedSubscription(id, "canceled")),
      async ({ cancel, refund }) => {
        await expectStatuses(deliver, 503, 503);
        expect(await getProcessedPayment(SESSION_ID)).toBeNull();
        expect(await storedPlans(listingId)).toEqual([]);

        started.invoice = stripeFirstInvoice();
        await expectStatuses(deliver, 302);
        await expectPlan(listingId, { ...EXPECTED_PLACEHOLDER, quantity: 2 });
        expectActions(cancel, refund, 0, 0);
      },
    );
  });

  for (const readableAmount of [false, true]) {
    test(`fails each delivery when a stored unpaid checkout later names a paid charge with a ${readableAmount ? "readable" : "still malformed"} amount`, async () => {
      await setupStripe();
      const listingId = await checkoutListingId();
      const started = startedCheckout(listingId);
      started.session.amount_total = null;
      started.session.payment_status = "unpaid";
      await withCheckoutActions(
        started,
        (id) => Promise.resolve(observedSubscription(id, "canceled")),
        async ({ cancel, refund }) => {
          await expectStatuses(deliver, 400);
          const owner = await placeholderOwner(listingId);
          expect(await failure()).toMatchObject({
            completion: { code: "malformed_charge" },
          });
          expect((await heldAnchor()).rows).toEqual([]);
          expectActions(cancel, refund, 1, 0);

          started.session.payment_status = "paid";
          if (readableAmount) started.session.amount_total = 2000;
          await expectStatuses(deliver, 503, 503);
          expectActions(cancel, refund, 1, 0);
          await expectPlan(listingId);
          expect(await placeholderOwner(listingId)).toBe(owner);
          expect((await failure()).refunded).not.toBe(true);
          expect(await allTransfers()).toEqual([]);
        },
      );
    });
  }

  test("retries an occupied fresh reservation without canceling or refunding its owner", async () => {
    await setupStripe();
    const listingId = await checkoutListingId();
    using cancel = stub(stripeApi, "cancelSubscription", (id) =>
      Promise.resolve(observedSubscription(id, "canceled")),
    );
    using refund = stubRefundPayment("re_after_reservation_release", 2000);
    using _env = withEnv({ TEST_EXPECT_ERROR: "1" });
    await withRejectedCheckout(
      listingId,
      "malformed charge",
      false,
      async () => {
        // This is the real in-flight reservation shape, not a completed outcome
        // cleared while its already-stored money and plan remain behind.
        expect(await reserveSession(SESSION_ID)).toEqual({ reserved: true });
        const occupied = await processed();
        expect(occupied.attendeeId).toBeNull();
        expect(occupied.failureData).toBe("");
        await expectStatuses(deliver, 503);
        expect(await processed()).toEqual(occupied);
        expectActions(cancel, refund, 0, 0);
        expect(await storedPlans(listingId)).toEqual([]);
        expect((await heldAnchor()).rows).toEqual([]);

        await releaseReservation(SESSION_ID);
        await expectStatuses(deliver, 400, 400);
        expectActions(cancel, refund, 1, 1);
        await expectPlan(listingId);
        await expectOnePairOfLegs(SESSION_ID);
      },
    );
  });

  test("releases an unreadable owned booking and still ends its subscription before refunding", async () => {
    await setupStripe();
    const listingId = await checkoutListingId();
    const started = startedCheckout(listingId);
    started.session.amount_total = null;
    started.session.metadata = signedMeta(
      { email: "member@example.com", items: "not-json", name: "Member" },
      2000,
    );
    let canEnd = false;
    await withCheckoutActions(
      started,
      async (id) => {
        expect(await getProcessedPayment(SESSION_ID)).toBeNull();
        expect(await storedPlans(listingId)).toEqual([]);
        return canEnd
          ? observedSubscription(id, "canceled")
          : refusedCancellation();
      },
      async ({ cancel, refund }) => {
        await expectStatuses(deliver, 503);
        expectActions(cancel, refund, 1, 0);
        expect(await getProcessedPayment(SESSION_ID)).toBeNull();
        canEnd = true;
        await expectStatuses(deliver, 400, 400);
        expectActions(cancel, refund, 3, 1);
        expect(await getProcessedPayment(SESSION_ID)).toBeNull();
        expect(await storedPlans(listingId)).toEqual([]);
        expect((await heldAnchor()).rows).toEqual([]);
        expect(await allTransfers()).toEqual([]);
      },
    );
  });
});
