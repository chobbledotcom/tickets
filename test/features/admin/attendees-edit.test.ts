import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { filter, map, pipe } from "#fp";
import { attendeeAccount, WORLD } from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import { mapBooking } from "#shared/accounting/mappers.ts";
import { postTransfers } from "#shared/accounting/store.ts";
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
import { createPaidAttendeeWithoutLedger } from "#test-utils/db-helpers/attendee-payments.ts";
import { bookTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postPaymentLeg } from "#test-utils/db-helpers/payment-leg.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { claimCurrentAttendeeRows } from "#test-utils/payment-claim.ts";
import { chargeMoney } from "#test-utils/payment-state.ts";
import {
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
    "pi_refresh_deposit",
    500,
  );
  await postPaymentLeg(
    attendee.id,
    500,
    "refresh-deposit-session",
    listing.id,
    800,
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

describeWithEnv("server (admin attendee refresh payment)", { db: true }, () => {
  describe("POST /admin/attendees/:attendeeId/refresh-payment", () => {
    test("records provider-refunded deposit and balance charges", async () => {
      const attendee = await setupBalanceRefresh(
        "refresh-balance-session",
        "pi_refresh_balance",
      );

      const queried = await submitRefreshPayment(attendee, (reference) =>
        Promise.resolve(
          ["pi_refresh_balance", "pi_refresh_deposit"].includes(reference),
        ),
      );

      expect([...queried].sort()).toEqual([
        "pi_refresh_balance",
        "pi_refresh_deposit",
      ]);
    });

    test("logs a refreshed refund against the first real booking", async () => {
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
        paymentId: "pi_refresh_first_real",
      });
      if (!created.success) throw new Error(`setup failed: ${created.reason}`);
      const attendee = created.attendees[0]!;
      await postTransfers(
        await mapBooking({
          amountPaid: 500,
          attendeeId: attendee.id,
          bookingFee: 0,
          eventId: "pi_refresh_first_real",
          lines: [
            { gross: 300, listingId: laterReal.id },
            { gross: 200, listingId: firstReal.id },
          ],
          modifiers: [],
          occurredAt: OCCURRED_AT,
        }),
      );

      await submitRefreshPayment(attendee, () => Promise.resolve(true));

      const message =
        "Payment marked as refunded for attendee 'First Real'; " +
        'payment references ["pi_refresh_first_real"]';
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
      await execute(
        `UPDATE processed_payments
            SET provider_refunded_at = ?
          WHERE payment_session_id = ?`,
        ["2026-07-01T00:01:00.000Z", "refresh-balance-already-refunded"],
      );

      const queried = await submitRefreshPayment(attendee, (reference) =>
        Promise.resolve(reference === "pi_refresh_deposit"),
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
      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 800,
      });
      const attendee = await createPaidAttendeeWithoutLedger(
        listing.id,
        "Not Refunded",
        "not-refunded@example.com",
        "pi_not_refunded",
        500,
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
      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 800,
      });
      const attendee = await createPaidAttendeeWithoutLedger(
        listing.id,
        "Already Refreshing",
        "already-refreshing@example.com",
        "pi_already_refreshing",
        500,
      );
      await claimCurrentAttendeeRows([attendee.id], "keyed");

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
        const listing = await createTestListing({
          maxAttendees: 50,
          unitPrice: 800,
        });
        const attendee = await createPaidAttendeeWithoutLedger(
          listing.id,
          "Refunded No Ledger",
          "refunded-no-ledger@example.com",
          "pi_refunded_no_ledger",
          500,
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
            `[Error] E_INVARIANT_REPORTED listing=${listing.id} ` +
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
    const errors = setupErrorSpy();

    test("is reported to the owner rather than read as nothing returned", async () => {
      const attendee = await setupBalanceRefresh(
        "refresh-partial-session",
        "pi_refresh_partial",
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

      expect(errors.contains("partial_refund")).toBe(true);
      expect(errors.contains("an owner needs to look at it")).toBe(true);
      expect(await getPaymentWorkStatus(attendee.id)).toBe("needs_review");
    });
  },
);
