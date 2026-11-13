// test-groups: run-alone
// The production entry's memoized boot changes the process-wide query guard.
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { bookingEventGroup } from "#accounting/mappers.ts";
import type { CreateAttendeeResult } from "#db/attendee-types.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { queryAll } from "#db/client.ts";
import { paymentReferenceIndex } from "#db/payment-reference-store.ts";
import {
  deleteAllStaleReservations,
  parseSessionFailure,
  STALE_RESERVATION_MS,
} from "#db/processed-payments.ts";
import {
  loadRefundAuthorityByReference,
  type RefundAuthorityRow,
} from "#db/provider-refund-authority.ts";
import { taggedPaymentReference } from "#payment/provider-reference.ts";
import {
  REFUND_NOT_SENT,
  type RefundAttemptResult,
} from "#payment/refund-attempt.ts";
import type { HeldAnchorSearch } from "#routes/api/payment-processing/placeholder-resume.ts";
import { requireValue } from "#shared/required-value.ts";
import { stripeApi } from "#shared/stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { serveFromBunny } from "#test-utils/entry.ts";
import { withEnv } from "#test-utils/env.ts";
import { signedMeta } from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { getProcessedPayment } from "#test-utils/processed-payments.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  answerCompletedStripeRefund,
  stripeFirstInvoice,
} from "#test-utils/stripe/fixtures.ts";
import { foundStripeIntent } from "#test-utils/stripe/responses.ts";
import { withSubscriptionStarted } from "#test-utils/stripe/subscription-checkout.ts";
import { expectTemporaryError } from "#test-utils/temporary-error.ts";
import { stubRefundPayment } from "#test-utils/webhooks/stripe.ts";
import {
  checkoutListingId,
  deliver,
  EXPECTED_PLACEHOLDER,
  expectActions,
  expectHeldPlan,
  expectPlan,
  expectStatuses,
  heldAnchor,
  observedSubscription,
  placeholderOwner,
  SESSION_ID,
  startedCheckout,
} from "./subscription-refund-helpers.ts";

const reference = taggedPaymentReference("stripe", "pi_first");
const checkoutMoney = async () => {
  const group = await bookingEventGroup(SESSION_ID);
  return queryAll(
    `SELECT kind, amount FROM transfers
     WHERE ? IN (event_group, reverses_group) ORDER BY kind`,
    [group],
  );
};

const retainedFailure = async () => {
  const row = requireValue(
    await getProcessedPayment(SESSION_ID),
    "Rejected checkout session not found",
  );
  expect(row.attendee_id).toBeNull();
  return requireValue(
    await parseSessionFailure(row.failure_data),
    "Rejected checkout outcome not found",
  );
};

const retryableCheckout = () =>
  serveFromBunny(mockRequest(`/payment/success?session_id=${SESSION_ID}`));

const untaxedPlan = { ...EXPECTED_PLACEHOLDER, recurring_tax: 0 };

const REFUND_EXPECTATIONS = {
  "not sent": {
    firstReads: 1,
    initialState: "ready",
    replayStatus: 400,
    sends: 2,
  },
  refused: {
    firstReads: 2,
    initialState: "needs_owner_choice",
    replayStatus: 503,
    sends: 1,
  },
} as const;

type RetainedRefund = {
  authority: RefundAuthorityRow;
  before: HeldAnchorSearch;
  index: string;
  owner: number;
};

const expectRefundRetry = async (
  failure: "refused" | "not sent",
  { authority, before, index, owner }: RetainedRefund,
): Promise<void> => {
  const after = await heldAnchor();
  expect(after.rows.map((row) => row.record.attendeeId)).toEqual([owner]);
  if (failure === "refused") {
    expect(after.held).toEqual(before.held);
    expect(await loadRefundAuthorityByReference(index)).toEqual(authority);
    expect((await retainedFailure()).refunded).not.toBe(true);
    expect(await checkoutMoney()).toEqual([]);
  } else {
    expect(after.held).toBeNull();
    expect(await loadRefundAuthorityByReference(index)).toMatchObject({
      id: authority.id,
      refunded: { amount: 2000, currency: "GBP" },
      state: { kind: "completed", local: { kind: "recorded" } },
    });
    expect((await retainedFailure()).refunded).toBe(true);
    expect(await checkoutMoney()).toEqual([
      { amount: 2000, kind: "payment" },
      { amount: 2000, kind: "refund_cash" },
    ]);
  }
};

describeWithEnv("rejected subscription retention errors", { db: true }, () => {
  for (const fault of ["reservation pruned", "booking refused"] as const) {
    test(`recovers ${fault} before stopping future charges`, async () => {
      await setupStripe();
      const listingId = await checkoutListingId();
      const started = startedCheckout(listingId);
      // Older signed checkout metadata can legitimately omit a tax policy.
      started.session.metadata = signedMeta(
        {
          ...requireValue(
            started.session.metadata,
            "Checkout metadata missing",
          ),
          name: "Member",
          tax_policy: "",
        },
        2000,
      );
      started.invoice = stripeFirstInvoice();
      started.invoice.payments.data = [];
      const attendeesBefore = await queryAll(
        "SELECT id FROM attendees ORDER BY id",
      );
      const paymentsBefore = await queryAll(
        "SELECT payment_session_id FROM processed_payments",
      );
      const create = attendeesApi.createAttendeeAtomic;
      let injectFault = true;
      using store = stub(
        attendeesApi,
        "createAttendeeAtomic",
        async (...args): Promise<CreateAttendeeResult> => {
          if (injectFault) {
            injectFault = false;
            if (fault === "booking refused") {
              // The documented atomic-operation seam models a refusal before
              // caller work runs; subsequent deliveries use the real engine.
              return {
                listingIds: [listingId],
                reason: "capacity_exceeded",
                success: false,
              };
            }
            const reserved = requireValue(
              await getProcessedPayment(SESSION_ID),
              "In-flight reservation missing",
            );
            expect(reserved.failure_data).toBe("");
            expect(reserved.attendee_id).toBeNull();
            {
              // A sufficiently delayed request can lose its empty reservation
              // to the real stale-row cleaner before its atomic plan store.
              using _clock = stub(
                Date,
                "now",
                () =>
                  Date.parse(reserved.processed_at) + STALE_RESERVATION_MS + 1,
              );
              expect(await deleteAllStaleReservations()).toBe(1);
            }
          }
          return create(...args);
        },
      );
      using cancel = stub(stripeApi, "cancelSubscription", async (id) => {
        await expectPlan(listingId, untaxedPlan);
        expect(await retainedFailure()).toMatchObject({
          completion: { code: "malformed_charge" },
          status: 200,
        });
        started.subscription.status = "canceled";
        return observedSubscription(id, "canceled");
      });
      using refund = stubRefundPayment("re_must_not_refund", 2000);
      using _env = withEnv({ TEST_EXPECT_ERROR: "1" });
      await withSubscriptionStarted(started, async () => {
        await expectTemporaryError(true)(await retryableCheckout());
        expectActions(cancel, refund, 0, 0);
        expect(await queryAll("SELECT id FROM attendees ORDER BY id")).toEqual(
          attendeesBefore,
        );
        expect(
          await queryAll("SELECT payment_session_id FROM processed_payments"),
        ).toEqual(paymentsBefore);
        expect(await getProcessedPayment(SESSION_ID)).toBeNull();
        expect(
          await queryAll(
            "SELECT attendee_id FROM listing_attendees WHERE listing_id = ?",
            [listingId],
          ),
        ).toEqual([]);
        expect(await checkoutMoney()).toEqual([]);

        await expectStatuses(retryableCheckout, 400, 400);
        expectActions(cancel, refund, 1, 0);
        expect(store.calls).toHaveLength(2);
        await expectPlan(listingId, untaxedPlan);
        const owner = await placeholderOwner(listingId);
        expect(await queryAll("SELECT id FROM attendees ORDER BY id")).toEqual([
          ...attendeesBefore,
          { id: owner },
        ]);
        expect(
          await queryAll(
            "SELECT payment_session_id FROM processed_payments WHERE attendee_id = ?",
            [owner],
          ),
        ).toEqual([]);
        expect((await retainedFailure()).refunded).not.toBe(true);
        expect(await checkoutMoney()).toEqual([]);
      });
    });
  }

  for (const failure of ["refused", "not sent"] as const) {
    test(`keeps a ${failure} refund unsettled`, async () => {
      await setupStripe();
      const listingId = await checkoutListingId();
      const started = startedCheckout(listingId);
      started.session.amount_total = null;
      using cancel = stub(stripeApi, "cancelSubscription", async (id) => {
        await expectHeldPlan(listingId);
        started.subscription.status = "canceled";
        return observedSubscription(id, "canceled");
      });
      using read = stub(stripeApi, "readPaymentIntent", (id) =>
        Promise.resolve(foundStripeIntent(id, 2000)),
      );
      let canReturn = false;
      const complete = answerCompletedStripeRefund("re_retained_retry");
      using refund = stub(
        stripeApi,
        "refundCharge",
        (request): Promise<RefundAttemptResult> => {
          if (canReturn) return complete(request);
          return Promise.resolve(
            failure === "refused"
              ? { kind: "rejected", reason: "rejected" }
              : REFUND_NOT_SENT,
          );
        },
      );
      using _env = withEnv({ TEST_EXPECT_ERROR: "1" });
      const expected = REFUND_EXPECTATIONS[failure];
      await withSubscriptionStarted(started, async () => {
        await expectStatuses(deliver, 503);
        expectActions(cancel, refund, 1, 1);
        expect(read.calls).toHaveLength(expected.firstReads);
        await expectPlan(listingId);
        const owner = await placeholderOwner(listingId);
        const before = await heldAnchor();
        expect(before.held?.record.attendeeId).toBe(owner);
        expect(await retainedFailure()).toMatchObject({
          completion: { code: "malformed_charge" },
          status: 200,
        });
        expect((await retainedFailure()).refunded).not.toBe(true);
        expect(await checkoutMoney()).toEqual([]);
        const index = await paymentReferenceIndex(reference);
        const authority = requireValue(
          await loadRefundAuthorityByReference(index),
          "Retained checkout refund authority missing",
        );
        expect(authority).toMatchObject({
          captured: { amount: 2000, currency: "GBP" },
          refunded: { amount: 0, currency: "GBP" },
          state: {
            kind: expected.initialState,
            local: { kind: "not_due" },
          },
        });
        if (failure === "refused") {
          expect(authority.state).toMatchObject({
            nextActionAt: null,
            reason: "provider_rejected",
          });
        }

        canReturn = true;
        await expectStatuses(
          deliver,
          expected.replayStatus,
          expected.replayStatus,
        );
        expectActions(cancel, refund, 1, expected.sends);
        expect(read.calls).toHaveLength(2);
        await expectPlan(listingId);
        expect(await placeholderOwner(listingId)).toBe(owner);
        await expectRefundRetry(failure, { authority, before, index, owner });
      });
    });
  }
});
