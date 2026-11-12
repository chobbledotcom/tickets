import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { parseSessionFailure } from "#db/processed-payments.ts";
import type { ProviderRead } from "#payment/provider-read.ts";
import { taggedPaymentReference } from "#payment/provider-reference.ts";
import { handleRequest } from "#routes";
import { findHeldAnchor } from "#routes/api/payment-processing/placeholder-resume.ts";
import { requireValue } from "#shared/required-value.ts";
import type { StripeSubscription } from "#shared/stripe/schemas.ts";
import { stripeApi } from "#shared/stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { pastCloseTime } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import type { TestListingOverrides } from "#test-utils/factories.ts";
import { mockWebhookRequest } from "#test-utils/mocks.ts";
import { getProcessedPayment } from "#test-utils/processed-payments.ts";
import { setupStripe, stubWebhookVerify } from "#test-utils/settings.ts";
import { stripeCheckoutSession } from "#test-utils/stripe/fixtures.ts";
import { withSubscriptionStarted } from "#test-utils/stripe/subscription-checkout.ts";
import { stubRefundPayment } from "#test-utils/webhooks/stripe.ts";
import {
  checkoutListingId,
  deliver,
  EXPECTED_PLACEHOLDER,
  expectActions,
  expectPlan,
  expectStatuses,
  observedSubscription,
  placeholderOwner,
  SESSION_ID,
  SUBSCRIPTION_ID,
  startedCheckout,
  withUntouchedSubscription,
} from "./subscription-refund-helpers.ts";

const heldAnchor = () =>
  findHeldAnchor(taggedPaymentReference("stripe", "pi_first"), SESSION_ID);

const FAILURES: { reason: string; listing: TestListingOverrides | null }[] = [
  { listing: { maxAttendees: 1 }, reason: "sold out" },
  { listing: { unitPrice: 1200 }, reason: "price changed" },
  { listing: null, reason: "listing removed" },
  { listing: { active: false }, reason: "inactive" },
  { listing: { closesAt: pastCloseTime() }, reason: "registration closed" },
  { listing: { maxQuantity: 4, minQuantity: 3 }, reason: "minimum raised" },
  { listing: { maxQuantity: 1 }, reason: "maximum lowered" },
];

const FAILED_CANCELLATIONS = {
  refused: () => ({ reason: "unsupported_status", status: "invalid" }),
  "still live": (id: string) => observedSubscription(id, "trialing"),
  unavailable: () => ({ reason: "not_configured", status: "unavailable" }),
} satisfies Record<string, (id: string) => ProviderRead<StripeSubscription>>;

describeWithEnv("subscription checkout refunds", { db: true }, () => {
  for (const { reason, listing } of FAILURES) {
    test(`ends the subscription before refunding when ${reason}`, async () => {
      await setupStripe();
      const listingId =
        listing === null ? 999999 : await checkoutListingId(listing);
      using cancel = stub(stripeApi, "cancelSubscription", async (id) => {
        await expectPlan(listingId);
        expect((await heldAnchor()).held?.record.attendeeId).toBe(
          await placeholderOwner(listingId),
        );
        return observedSubscription(id, "canceled");
      });
      using refund = stubRefundPayment("re_failed_subscription", 2000);
      await withSubscriptionStarted(startedCheckout(listingId), async () => {
        const response = await deliver();
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("refunded");
        await expectStatuses(deliver, 200);
        expect(cancel.calls.map((call) => call.args)).toEqual([
          [SUBSCRIPTION_ID],
        ]);
        expectActions(cancel, refund, 1, 1);
        await expectPlan(listingId);
        expect((await heldAnchor()).held).toBeNull();
      });
    });
  }

  for (const [firstAnswer, firstRead] of Object.entries(FAILED_CANCELLATIONS)) {
    test(`retries ${firstAnswer} cancellation from the same held placeholder`, async () => {
      await setupStripe();
      const listingId = await checkoutListingId({ maxAttendees: 1 });
      const started = startedCheckout(listingId);
      using _verify =
        firstAnswer === "unavailable"
          ? await stubWebhookVerify({
              data: {
                object: stripeCheckoutSession({
                  ...started.session,
                  invoice: "in_first",
                  mode: "subscription",
                  payment_intent: null,
                  subscription: SUBSCRIPTION_ID,
                }),
              },
              id: "evt_failed_subscription",
              type: "checkout.session.completed",
            })
          : null;
      const request =
        firstAnswer === "unavailable"
          ? () =>
              handleRequest(
                mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
              )
          : deliver;
      let canEnd = false;
      using cancel = stub(stripeApi, "cancelSubscription", (id) =>
        Promise.resolve(
          canEnd ? observedSubscription(id, "canceled") : firstRead(id),
        ),
      );
      using refund = stubRefundPayment("re_retry_subscription", 2000);
      using _env = withEnv({ TEST_EXPECT_ERROR: "1" });
      await withSubscriptionStarted(started, async () => {
        await expectStatuses(request, 503);
        expectActions(cancel, refund, 1, 0);
        await expectPlan(listingId);
        const before = (await heldAnchor()).held;
        expect(before?.record.attendeeId).toBe(
          await placeholderOwner(listingId),
        );
        const failed = requireValue(
          await getProcessedPayment(SESSION_ID),
          "Failed checkout session not found",
        );
        expect(failed.attendee_id).toBeNull();
        expect(await parseSessionFailure(failed.failure_data)).toMatchObject({
          completion: { code: "capacity_full" },
          status: 200,
        });
        canEnd = true;
        await expectStatuses(request, 200, 200);
        expectActions(cancel, refund, 2, 1);
        await expectPlan(listingId);
        const after = await heldAnchor();
        expect(after.held).toBeNull();
        expect(after.rows.map((row) => row.record.attendeeId)).toEqual([
          before!.record.attendeeId,
        ]);
      });
    });
  }

  for (const alreadyEnded of [false, true]) {
    test(`accepts cancellation observed ${alreadyEnded ? "before completion" : "after a refused cancel"}`, async () => {
      await setupStripe();
      const listingId = await checkoutListingId({ maxAttendees: 1 });
      const started = startedCheckout(listingId);
      const initialStatus = alreadyEnded ? "canceled" : "trialing";
      started.subscription.status = initialStatus;
      using cancel = stub(stripeApi, "cancelSubscription", () => {
        started.subscription.status = "canceled";
        return Promise.resolve({
          reason: "unsupported_status" as const,
          status: "invalid" as const,
        });
      });
      using refund = stubRefundPayment("re_concurrent_cancel", 2000);
      await withSubscriptionStarted(started, async () => {
        await expectStatuses(deliver, 200, 200);
        expectActions(cancel, refund, alreadyEnded ? 0 : 1, 1);
        await expectPlan(listingId, {
          ...EXPECTED_PLACEHOLDER,
          subscription_status: initialStatus,
        });
      });
    });
  }

  test("never cancels or refunds a successful booking or its replay", async () => {
    await withUntouchedSubscription(async (listingId) => {
      await withSubscriptionStarted(startedCheckout(listingId), async () => {
        await expectStatuses(deliver, 302, 200);
        await expectPlan(listingId, { ...EXPECTED_PLACEHOLDER, quantity: 2 });
      });
    });
  });
});
