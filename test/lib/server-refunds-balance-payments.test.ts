import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeeStatuses } from "#shared/db/attendee-statuses.ts";
import { createAttendeeAtomic } from "#shared/db/attendees/api.ts";
import { settleAttendeeBalance } from "#shared/db/attendees/balance.ts";
import { balanceFinalizeStatement } from "#shared/db/payment-finalize.ts";
import { reserveSession } from "#shared/db/processed-payments.ts";
import type { Attendee, Listing } from "#shared/types.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
} from "#test-utils/assertions.ts";
import { settle } from "#test-utils/balance.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { finalizeTestPaymentSession as finalizePaymentSession } from "#test-utils/db-helpers/processed-payments.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import {
  expectSingleRefundIssued,
  postRefundAll,
  submitRefund,
  withRefundMock,
} from "#test-utils/refund-routes.ts";
import { adminGet, testCookie, testCsrfToken } from "#test-utils/session.ts";
import type { RefundCtx } from "./server-refunds-helpers.ts";

const SETTLED_RESERVATION_REFERENCES = [
  "pi_reservation_balance",
  "pi_reservation_deposit",
];

const expectSettledReservationRefundFailure = async (
  ctx: RefundCtx,
  refundBehavior: Parameters<typeof withRefundMock>[0],
) => {
  await withRefundMock(refundBehavior, async (mockRefund) => {
    const response = await submitRefund(ctx);
    await expectFlashRedirect(
      `/admin/attendees/${ctx.attendee.id}/refund`,
      expect.stringContaining("Refund failed"),
      false,
    )(response);
    expect(mockRefund.calls.map((call) => call.args[0]).sort()).toEqual(
      SETTLED_RESERVATION_REFERENCES,
    );
  });
};

const refundCtx = async (
  attendee: Attendee,
  listing: Listing,
): Promise<RefundCtx> => ({
  attendee,
  cookie: await testCookie(),
  csrfToken: await testCsrfToken(),
  listing,
});

const setupBalancePaidRefundTest = async (): Promise<RefundCtx> => {
  const listing = await createTestListing({
    maxAttendees: 100,
    unitPrice: 1500,
  });
  const status = await attendeeStatuses.table.insert({
    isReservation: false,
    name: "Confirmed",
    reservationAmount: "0",
  });
  const created = await createAttendeeAtomic({
    bookings: [{ listingId: listing.id, pricePaid: 0, quantity: 1 }],
    email: "balance@example.com",
    name: "John Doe",
    statusId: status.id,
  });
  if (!created.success) throw new Error("setup failed");
  const attendee = created.attendees[0]!;
  await postListingSale({
    amountPaid: 0,
    attendeeId: attendee.id,
    gross: 1500,
    listingId: listing.id,
  });
  await reserveSession("balance_refund_session");
  await settleAttendeeBalance(
    attendee.id,
    1500,
    settle("balance_refund_session"),
    [
      await balanceFinalizeStatement(
        "balance_refund_session",
        attendee.id,
        1500,
        "pi_balance_refund",
      ),
    ],
  );
  return refundCtx(attendee, listing);
};

const setupSettledReservationRefundTest = async (): Promise<RefundCtx> => {
  const listing = await createTestListing({
    maxAttendees: 100,
    unitPrice: 10000,
  });
  const status = await attendeeStatuses.table.insert({
    isReservation: true,
    name: "Reserved",
    reservationAmount: "20%",
  });
  const created = await createAttendeeAtomic({
    bookings: [{ listingId: listing.id, pricePaid: 2000, quantity: 1 }],
    email: "reservation@example.com",
    name: "John Doe",
    paymentId: "pi_reservation_deposit",
    remainingBalance: 8000,
    statusId: status.id,
  });
  if (!created.success) throw new Error("setup failed");
  const attendee = created.attendees[0]!;
  await postListingSale({
    amountPaid: 2000,
    attendeeId: attendee.id,
    eventId: "reservation_deposit_session",
    gross: 10000,
    listingId: listing.id,
  });
  await reserveSession("reservation_deposit_session");
  await finalizePaymentSession(
    "reservation_deposit_session",
    attendee.id,
    [],
    "pi_reservation_deposit",
  );
  await reserveSession("reservation_balance_session");
  await settleAttendeeBalance(
    attendee.id,
    8000,
    settle("reservation_balance_session"),
    [
      await balanceFinalizeStatement(
        "reservation_balance_session",
        attendee.id,
        8000,
        "pi_reservation_balance",
      ),
    ],
  );
  return refundCtx(attendee, listing);
};

describeWithEnv("server (admin balance-payment refunds)", { db: true }, () => {
  describe("single attendee refund", () => {
    const errors = setupErrorSpy();

    test("refunds a balance-paid attendee whose original row has no payment id", async () => {
      const ctx = await setupBalancePaidRefundTest();

      await expectSingleRefundIssued(ctx, (mockRefund) => {
        expect(mockRefund.calls.map((call) => call.args[0])).toEqual([
          "pi_balance_refund",
        ]);
      });
    });

    test("refunds both charges for a settled reservation", async () => {
      const ctx = await setupSettledReservationRefundTest();

      await expectSingleRefundIssued(ctx, (mockRefund) => {
        expect(mockRefund.calls.map((call) => call.args[0]).sort()).toEqual(
          SETTLED_RESERVATION_REFERENCES,
        );
      });
    });

    test("logs when a settled reservation refund misses one of its charges", async () => {
      const ctx = await setupSettledReservationRefundTest();

      await expectSettledReservationRefundFailure(ctx, false);
      expect(
        errors.calls
          .map((call) => String(call.args[0]))
          .some((message) =>
            message.includes("did not complete every payment"),
          ),
      ).toBe(true);
    });

    test("records a returned charge when the other charge fails", async () => {
      const ctx = await setupSettledReservationRefundTest();

      await expectSettledReservationRefundFailure(ctx, (reference) =>
        Promise.resolve(reference === "pi_reservation_deposit"),
      );

      await expectSingleRefundIssued(ctx, (mockRefund) => {
        expect(mockRefund.calls.map((call) => call.args[0])).toEqual([
          "pi_reservation_balance",
        ]);
      });
    });
  });

  describe("bulk refund and actions", () => {
    test("bulk refund includes a balance-paid attendee with no legacy payment id", async () => {
      const ctx = await setupBalancePaidRefundTest();

      await withRefundMock(true, async (mockRefund) => {
        const response = await postRefundAll(ctx.listing);
        await expectFlashRedirect(
          `/admin/listing/${ctx.listing.id}`,
          "All attendees refunded",
        )(response);
        expect(mockRefund.calls.map((call) => call.args[0])).toEqual([
          "pi_balance_refund",
        ]);
      });
    });

    test("shows the Refund action for a balance-paid attendee with no legacy payment id", async () => {
      const ctx = await setupBalancePaidRefundTest();
      const response = await adminGet(
        `/admin/attendees/${ctx.attendee.id}/actions`,
      );
      const html = await expectHtmlResponse(response, 200);
      expect(html).toContain(`/admin/attendees/${ctx.attendee.id}/refund`);
    });
  });
});
