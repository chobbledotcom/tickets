import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { filter, map, pipe } from "#fp";
import { attendeeAccount, WORLD } from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import { mapBooking } from "#shared/accounting/mappers.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { REFRESH_BUDGET_MESSAGE } from "#routes/admin/refunds/budget.ts";
import type { ActivityLogEntry } from "#shared/db/activity-log.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { balanceEventGroup } from "#shared/db/attendees/balance.ts";
import { execute } from "#shared/db/client.ts";
import { getPaymentWorkStatus } from "#shared/db/payment-review.ts";
import { reserveSession } from "#shared/db/processed-payments.ts";
import type { Attendee } from "#shared/types.ts";
import { getAttendeeActivityLog } from "#test-utils/activity-log.ts";
import { expectErrorFlash, expectFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createPaidAttendeeWithoutLedger,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { bookTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postPaymentLeg } from "#test-utils/db-helpers/payment-leg.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { claimCurrentAttendeeRows } from "#test-utils/payment-claim.ts";
import { chargeMoney } from "#test-utils/payment-state.ts";
import {
  getCompleteRefundPaymentReferencesForAttendee,
  markProviderRefundsReturned,
} from "#test-utils/payment-references.ts";
import {
  finalizeProcessedPayment,
  finalizeReservedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";
import {
  withRefreshPaymentMoney,
  withRefreshPaymentProbe,
} from "#test-utils/refund-routes.ts";
import { adminFormPost } from "#test-utils/session.ts";

const OCCURRED_AT = "2026-07-01T00:00:00.000Z";

const setupBalanceRefresh = async (
  balanceSessionId: string,
  balancePaymentId: string,
): Promise<Attendee> => {
  const listing = await createTestListing({
    maxAttendees: 100,
    unitPrice: 800,
  });
  const attendee = await createPaidAttendeeWithoutLedger(
    listing.id,
    "John Doe",
    "john@example.com",
    "",
    500,
  );
  const depositSessionId = "refresh-deposit-session";
  await postPaymentLeg(
    attendee.id,
    500,
    depositSessionId,
    listing.id,
    800,
  );
  await finalizeProcessedPayment(
    depositSessionId,
    attendee.id,
    "",
    taggedPaymentReference("pi_refresh_deposit"),
  );
  await postTransfers([
    {
      amount: 300,
      destination: attendeeAccount(attendee.id),
      eventGroup: await balanceEventGroup(balanceSessionId),
      kind: KIND.payment,
      occurredAt: OCCURRED_AT,
      reference: "refresh-balance",
      source: WORLD,
    },
  ]);
  await reserveSession(balanceSessionId);
  await finalizeReservedPayment(
    balanceSessionId,
    attendee.id,
    "",
    taggedPaymentReference(balancePaymentId),
  );
  return attendee;
};

const setupTaggedRefresh = async (
  label: string,
  name: string,
): Promise<{ attendee: Attendee; listingId: number }> => {
  const listing = await createTestListing({
    maxAttendees: 50,
    unitPrice: 800,
  });
  const attendee = await createPaidAttendeeWithoutLedger(
    listing.id,
    name,
    `${label}@example.com`,
    "",
    500,
  );
  await finalizeProcessedPayment(
    `refresh-${label}-session`,
    attendee.id,
    "",
    taggedPaymentReference(`pi_${label}`),
  );
  return { attendee, listingId: listing.id };
};

/** Submits the refresh-payment route with a stubbed provider so each refund
 *  reference's provider status is whatever `refundedPredicate` returns.
 *  Returns the references the route actually asked the provider about, in
 *  call order, and asserts on the expected flash + success flag so a mutant
 *  that picks the wrong redirect or message is caught at the response. */
const submitRefreshPayment = async (
  attendee: Attendee,
  refundedPredicate: (reference: string) => Promise<boolean>,
  // deno-lint-ignore no-explicit-any
  expectedFlash: string | any = expect.stringContaining("refunded"),
  succeeded = true,
): Promise<string[]> => {
  const providerQueries: string[] = [];
  await withRefreshPaymentProbe(
    (reference: string) => {
      providerQueries.push(reference);
      return refundedPredicate(reference);
    },
    async () => {
      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/refresh-payment`,
      );
      expectFlash(response, expectedFlash, succeeded);
    },
  );
  return providerQueries;
};

const expectIncompleteRefreshRefused = async (
  attendee: Attendee,
): Promise<void> => {
  const queried = await submitRefreshPayment(
    attendee,
    () => Promise.resolve(false),
    expect.stringContaining("older payment history"),
    false,
  );

  expect(queried).toEqual([]);
};

describeWithEnv("server (admin attendee refresh payment)", { db: true }, () => {
  describe("POST /admin/attendees/:attendeeId/refresh-payment", () => {
    test("refuses two unresolved tagged charges before provider reads", async () => {
      const attendee = await setupBalanceRefresh(
        "refresh-balance-session",
        "pi_refresh_balance",
      );

      const queried = await submitRefreshPayment(
        attendee,
        (reference) =>
          Promise.resolve(
            ["pi_refresh_balance", "pi_refresh_deposit"].includes(reference),
          ),
        REFRESH_BUDGET_MESSAGE,
        false,
      );

      expect(queried).toEqual([]);
    });

    test("does not refresh an indexed balance while its tagged deposit is unindexed", async () => {
      const attendee = await setupBalanceRefresh(
        "refresh-incomplete-balance-session",
        "pi_refresh_incomplete_balance",
      );
      await execute(
        `UPDATE processed_payments
            SET payment_reference_index = ''
          WHERE attendee_id = ?
            AND payment_session_id != ?`,
        [attendee.id, "refresh-incomplete-balance-session"],
      );

      await expectIncompleteRefreshRefused(attendee);
    });

    test("logs a repeated refund refresh once against the first real booking", async () => {
      const ghost = await createTestListing({
        listingType: "daily",
        maxAttendees: 100,
        unitPrice: 0,
      });
      const laterReal = await createTestListing({
        listingType: "daily",
        maxAttendees: 100,
        unitPrice: 300,
      });
      const firstReal = await createTestListing({
        listingType: "daily",
        maxAttendees: 100,
        unitPrice: 200,
      });
      const created = await attendeesApi.createAttendeeAtomic({
        bookings: [
          {
            date: "2026-08-01",
            listingId: ghost.id,
            pricePaid: 0,
            quantity: 0,
          },
          {
            date: "2026-08-03",
            listingId: laterReal.id,
            pricePaid: 300,
            quantity: 1,
          },
          {
            date: "2026-08-02",
            listingId: firstReal.id,
            pricePaid: 200,
            quantity: 1,
          },
        ],
        email: "first-real@example.com",
        name: "First Real",
        paymentId: "",
      });
      if (!created.success) throw new Error(`setup failed: ${created.reason}`);
      const attendee = created.attendees[0]!;
      const paymentSessionId = "refresh-first-real-session";
      await postTransfers(
        await mapBooking({
          amountPaid: 500,
          attendeeId: attendee.id,
          bookingFee: 0,
          eventId: paymentSessionId,
          lines: [
            { gross: 300, listingId: laterReal.id },
            { gross: 200, listingId: firstReal.id },
          ],
          modifiers: [],
          occurredAt: OCCURRED_AT,
        }),
      );
      await finalizeProcessedPayment(
        paymentSessionId,
        attendee.id,
        "",
        taggedPaymentReference("pi_refresh_first_real"),
      );

      await submitRefreshPayment(attendee, () => Promise.resolve(true));
      await submitRefreshPayment(
        attendee,
        () => Promise.resolve(true),
        expect.stringContaining("up to date"),
      );

      const message = "Payment marked as refunded";
      expect(
        pipe(
          filter((entry: ActivityLogEntry) => entry.message === message),
          map(({ attendee_id, listing_id }) => ({ attendee_id, listing_id })),
        )(await getAttendeeActivityLog(attendee.id)),
      ).toEqual([{ attendee_id: attendee.id, listing_id: firstReal.id }]);
    });

    test("reuses already-refunded balance charges before recording the refund", async () => {
      const attendee = await setupBalanceRefresh(
        "refresh-balance-already-refunded",
        "pi_refresh_balance_done",
      );
      const balanceReference = (
        await getCompleteRefundPaymentReferencesForAttendee(attendee)
      ).find(({ reference }) => reference === "pi_refresh_balance_done");
      if (balanceReference === undefined) {
        throw new Error("The balance refund reference was not loaded");
      }
      await markProviderRefundsReturned(
        [balanceReference],
        "due",
      );

      const queried = await submitRefreshPayment(
        attendee,
        (reference) => Promise.resolve(reference === "pi_refresh_deposit"),
      );

      expect(queried).toEqual(["pi_refresh_deposit"]);
    });

    test("returns 404 with an empty body for a non-existent attendee", async () => {
      const { response } = await adminFormPost(
        "/admin/attendees/9999999/refresh-payment",
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
    });

    test("reports no payment to refresh for an attendee without payment references", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });
      const attendee = await bookTestAttendee(
        [listing.id],
        "No Refs",
        "no-refs@example.com",
      );

      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/refresh-payment`,
      );
      expectErrorFlash(response, "No payment to refresh");
    });

    test("reports the status is current when a provider charge is not refunded", async () => {
      const { attendee } = await setupTaggedRefresh(
        "not_refunded",
        "Not Refunded",
      );

      const queried = await submitRefreshPayment(
        attendee,
        () => Promise.resolve(false),
        expect.stringContaining("up to date"),
        true,
      );

      expect(queried).toEqual(["pi_not_refunded"]);
    });

    test("reports a refund already in progress when another run owns the payment", async () => {
      const { attendee } = await setupTaggedRefresh(
        "already_refreshing",
        "Already Refreshing",
      );
      await claimCurrentAttendeeRows([attendee.id]);

      const { response } = await adminFormPost(
        `/admin/attendees/${attendee.id}/refresh-payment`,
      );

      expectErrorFlash(
        response,
        "A refund for this payment is still settling. Refresh payment status after it completes.",
      );
    });

    describe("a provider refund the ledger has no clean order to reverse", () => {
      const errors = setupErrorSpy();

      test("records a refund-not-recorded error and reports the broken promise", async () => {
        const { attendee, listingId } = await setupTaggedRefresh(
          "refunded_no_ledger",
          "Refunded No Ledger",
        );

        await submitRefreshPayment(
          attendee,
          () => Promise.resolve(true),
          "The payment provider sent the refund. It could not be recorded in Money. Fix Money, then refresh payment status. Do not send the refund again.",
          false,
        );
        // Money moved without a ledger record: the flash alone is not enough,
        // the incident must reach the classified error fan-out too.
        expect(
          errors.contains(
            `[Error] E_INVARIANT_REPORTED listing=${listingId} ` +
              `attendee=${attendee.id} detail="error.refund_not_recorded"`,
          ),
        ).toBe(true);
      });
    });
  });
});

describeWithEnv(
  "server (admin attendee refresh payment) > a charge only partly returned",
  { db: true },
  () => {
    test("is sent to owner refund recovery rather than read as nothing returned", async () => {
      const { attendee } = await setupTaggedRefresh(
        "refresh_partial",
        "Partly Refunded",
      );

      await withRefreshPaymentMoney(
        // Some of the money went back, but not all of it. The provider's
        // records and this booking disagree, and no retry settles that.
        () => Promise.resolve(chargeMoney(1000, 400)),
        async () => {
          const { response } = await adminFormPost(
            `/admin/attendees/${attendee.id}/refresh-payment`,
          );
          expectFlash(
            response,
            "This payment needs an owner review before another refund can be attempted.",
            false,
          );
        },
      );

      expect(await getPaymentWorkStatus(attendee.id)).toBe(
        "needs_provider_recovery",
      );
    });
  },
);
