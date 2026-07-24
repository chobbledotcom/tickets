import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { filter, map, pipe } from "#fp";
import { attendeeAccount, WORLD } from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import { mapBooking } from "#shared/accounting/mappers.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import type { ActivityLogEntry } from "#shared/db/activityLog.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { balanceEventGroup } from "#shared/db/attendees/balance.ts";
import { execute } from "#shared/db/client.ts";
import { reserveSession } from "#shared/db/processed-payments.ts";
import type { Attendee } from "#shared/types.ts";
import { getAttendeeActivityLog } from "#test-utils/activity-log.ts";
import { expectErrorFlash, expectFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createPaidAttendeeWithoutLedger } from "#test-utils/db-helpers/attendee-payments.ts";
import { bookTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { finalizeReservedPayment } from "#test-utils/processed-payments.ts";
import { withRefreshPaymentProbe } from "#test-utils/refund-routes.ts";
import { adminFormPost } from "#test-utils/session.ts";

const OCCURRED_AT = "2026-07-01T00:00:00.000Z";

/** Post a payment leg for one booking line (no sale leg). Shared by the
 *  balance-refresh setup and the placeholder-reconciliation test so the
 *  mapBooking/postTransfers shape stays in one place. */
const postPaymentLeg = async (
  attendeeId: number,
  amount: number,
  eventId: string,
  listingId: number,
  gross: number,
): Promise<void> => {
  await postTransfers(
    await mapBooking({
      amountPaid: amount,
      attendeeId,
      bookingFee: 0,
      eventId,
      lines: [{ gross, listingId }],
      modifiers: [],
      occurredAt: OCCURRED_AT,
    }),
  );
};

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
    balancePaymentId,
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

      const message = "Payment marked as refunded for attendee 'First Real'";
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

    test("records a refund-not-recorded error when the ledger has no clean order to reverse", async () => {
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
        "The payment provider sent the refund. It could not be recorded in Money. Add a correction. Do not send the refund again.",
        false,
      );
    });

    /** Create a quantity-0 placeholder attendee with a payment leg, finalize
     *  the payment reference, and optionally run a callback before the refresh.
     *  Shared by the placeholder reconciliation tests. */
    const setupPlaceholderForRefresh = async (
      name: string,
      email: string,
      sessionId: string,
      paymentReference: string,
      beforeRefresh?: () => Promise<void>,
    ): Promise<Attendee> => {
      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 800,
      });
      const created = await attendeesApi.createAttendeeAtomic({
        bookings: [
          {
            date: "2026-08-01",
            listingId: listing.id,
            pricePaid: 0,
            quantity: 0,
          },
        ],
        email,
        name,
        paymentId: paymentReference,
      });
      if (!created.success) throw new Error(`setup failed: ${created.reason}`);
      const attendee = created.attendees[0]!;
      await postPaymentLeg(attendee.id, 500, sessionId, listing.id, 0);
      await reserveSession(sessionId);
      await finalizeReservedPayment(
        sessionId,
        attendee.id,
        "tok-placeholder",
        paymentReference,
      );
      if (beforeRefresh) await beforeRefresh();
      return attendee;
    };

    /** Submit the refresh with the provider reporting the refund as settled,
     *  and verify the refund_cash leg was posted to the attendee's account. */
    const refreshAndVerifyRefundCash = async (
      attendee: Attendee,
    ): Promise<void> => {
      await submitRefreshPayment(attendee, () => Promise.resolve(true));
      const legs = await transfersByAccount(attendeeAccount(attendee.id));
      expect(legs.some((leg) => leg.kind === KIND.refundCash)).toBe(true);
    };

    test("reconciles a quantity-0 placeholder when its refund later settles", async () => {
      const attendee = await setupPlaceholderForRefresh(
        "Placeholder",
        "placeholder@example.com",
        "placeholder-refresh-session",
        "pi_placeholder_refresh",
      );
      await refreshAndVerifyRefundCash(attendee);
    });

    test("reconciles a placeholder whose listing was since deleted", async () => {
      const attendee = await setupPlaceholderForRefresh(
        "Deleted Placeholder",
        "deleted-listing@example.com",
        "placeholder-deleted-listing-session",
        "pi_placeholder_deleted",
        async () => {
          await execute("DELETE FROM listings WHERE id = ?", [0]);
        },
      );
      await refreshAndVerifyRefundCash(attendee);
    });
  });
});
