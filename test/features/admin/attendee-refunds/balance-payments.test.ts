import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeeStatuses } from "#shared/db/attendee-statuses.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { settleAttendeeBalance } from "#shared/db/attendees/balance.ts";
import { updateAttendeePII } from "#shared/db/attendees/update.ts";
import { execute } from "#shared/db/client.ts";
import { balanceFinalizeStatements } from "#shared/db/payment-finalize.ts";
import { reserveSession } from "#shared/db/processed-payments.ts";
import type { Attendee, Listing } from "#shared/types.ts";
import type { RefundCtx } from "#test/features/admin/refunds-helpers.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
} from "#test-utils/assertions.ts";
import { settle } from "#test-utils/balance.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { attendeePiiOf } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import {
  putRowState,
  rowStateSlot,
  UNRECORDED_MIRROR,
} from "#test-utils/payment-claim.ts";
import {
  finalizeReservedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";
import {
  expectSingleRefundIssued,
  postRefundAll,
  refundCompletes,
  submitRefund,
  withRefundMock,
} from "#test-utils/refund-routes.ts";
import { adminGet, testCookie, testCsrfToken } from "#test-utils/session.ts";

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
  const created = await attendeesApi.createAttendeeAtomic({
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
    await balanceFinalizeStatements(
      "balance_refund_session",
      attendee.id,
      1500,
      taggedPaymentReference("pi_balance_refund"),
    ),
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
  const created = await attendeesApi.createAttendeeAtomic({
    bookings: [{ listingId: listing.id, pricePaid: 2000, quantity: 1 }],
    email: "reservation@example.com",
    name: "John Doe",
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
  await finalizeReservedPayment(
    "reservation_deposit_session",
    attendee.id,
    "",
    taggedPaymentReference("pi_reservation_deposit"),
  );
  await reserveSession("reservation_balance_session");
  await settleAttendeeBalance(
    attendee.id,
    8000,
    settle("reservation_balance_session"),
    await balanceFinalizeStatements(
      "reservation_balance_session",
      attendee.id,
      8000,
      taggedPaymentReference("pi_reservation_balance"),
    ),
  );
  return refundCtx(attendee, listing);
};

const expectIncompleteReservationHistoryRefused = async (
  changeHistory: (ctx: RefundCtx) => Promise<void>,
): Promise<void> => {
  const ctx = await setupSettledReservationRefundTest();
  await changeHistory(ctx);

  await withRefundMock(refundCompletes, async (mockRefund) => {
    const response = await submitRefund(ctx);
    await expectFlashRedirect(
      `/admin/attendees/${ctx.attendee.id}/actions`,
      expect.stringContaining("older payment history"),
      false,
    )(response);
    expect(mockRefund.calls).toEqual([]);
  });
};

describeWithEnv("server (admin balance-payment refunds)", { db: true }, () => {
  describe("single attendee refund", () => {
    test("refunds a balance-paid attendee whose original row has no payment id", async () => {
      const ctx = await setupBalancePaidRefundTest();

      await expectSingleRefundIssued(ctx, (mockRefund) => {
        expect(
          mockRefund.calls.map((call) => call.args[0].paymentReference),
        ).toEqual(["pi_balance_refund"]);
      });
    });

    test("refuses two charges before provider work exceeds the request budget", async () => {
      const ctx = await setupSettledReservationRefundTest();

      await withRefundMock(refundCompletes, async (mockRefund) => {
        await expectFlashRedirect(
          `/admin/attendees/${ctx.attendee.id}/refund`,
          "This attendee has too many payments to refund in one go. Refund them from the provider dashboard.",
          false,
        )(await submitRefund(ctx));
        expect(mockRefund.calls).toEqual([]);
      });
    });

    test("does not refund an indexed balance while an old deposit is unindexed", async () => {
      await expectIncompleteReservationHistoryRefused(async () => {
        await execute(
          `UPDATE processed_payments
              SET payment_reference_index = ''
            WHERE payment_session_id = ?`,
          ["reservation_deposit_session"],
        );
      });
    });

    test("does not refund an indexed balance while its PII-only deposit is unindexed", async () => {
      await expectIncompleteReservationHistoryRefused(async (ctx) => {
        await updateAttendeePII(ctx.attendee.id, {
          ...attendeePiiOf(ctx.attendee),
          payment_id: "pi_reservation_deposit",
        });
        await execute(
          "DELETE FROM processed_payments WHERE payment_session_id = ?",
          ["reservation_deposit_session"],
        );
      });
    });
  });

  describe("bulk refund and actions", () => {
    test("bulk refund includes a balance-paid attendee with no legacy payment id", async () => {
      const ctx = await setupBalancePaidRefundTest();

      await withRefundMock(refundCompletes, async (mockRefund) => {
        const response = await postRefundAll(ctx.listing);
        await expectFlashRedirect(
          `/admin/listing/${ctx.listing.id}`,
          "All attendees refunded",
        )(response);
        expect(
          mockRefund.calls.map((call) => call.args[0].paymentReference),
        ).toEqual(["pi_balance_refund"]);
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

    test("keeps refresh reachable when a balance-only refund needs Money", async () => {
      const ctx = await setupBalancePaidRefundTest();
      expect(ctx.attendee.payment_id).toBe("");
      await putRowState(
        "balance_refund_session",
        await rowStateSlot({
          unrecorded: { returnedAt: "2026-08-12T10:00:00.000Z" },
        }),
        UNRECORDED_MIRROR,
      );

      const actions = await expectHtmlResponse(
        await adminGet(`/admin/attendees/${ctx.attendee.id}/actions`),
        200,
      );
      expect(actions).not.toContain(
        `/admin/attendees/${ctx.attendee.id}/refund`,
      );
      expect(actions).not.toContain(
        `/admin/attendees/${ctx.attendee.id}/payment-review`,
      );

      const overview = await expectHtmlResponse(
        await adminGet(`/admin/attendees/${ctx.attendee.id}`),
        200,
      );
      expect(overview).toContain(
        `action="/admin/attendees/${ctx.attendee.id}/refresh-payment"`,
      );
      expect(overview).toContain("Refresh payment status");
    });
  });
});
