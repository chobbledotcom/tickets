// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { signBalanceToken } from "#shared/balance-link.ts";
import { attendeeStatuses } from "#shared/db/attendee-statuses.ts";
import { getAttendeeOrderSummary } from "#shared/db/attendees/balance.ts";
import { getDb } from "#shared/db/client.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { stripeApi } from "#shared/stripe.ts";
import {
  bookFreeOrder,
  bookPaidReservation,
} from "#test/lib/server-reservation/_shared-setup.ts";
import {
  createProgrammeCharge,
  createSave10Promo,
  expectRefundedPlaceholder,
  latestAttendee,
  modifierRefs,
  setPublicReservation,
  setupReservationListing,
  stubPaidSession,
} from "#test/lib/server-reservation/helpers.ts";
import { captureCheckoutSnapshot } from "#test-utils/checkout.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  modifierUsageAmount,
  modifierUsageCount,
} from "#test-utils/modifiers.ts";

// jscpd:ignore-end

describeWithEnv(
  "server (reservation deposit at checkout)",
  { db: true },
  () => {
    test("reservation balance page shows cash paid and the discounted full price", async () => {
      const listing = await setupReservationListing({
        bookingFee: "0",
        reservationAmount: "10%",
      });
      const promo = await createSave10Promo();
      // Full modified subtotal £9.00, deposit 10% = £0.90.
      const session = stubPaidSession(
        "cs_discount_dep",
        {
          _origin: "localhost",
          email: "reserver@example.com",
          items: JSON.stringify([{ e: listing.id, p: 1000, q: 1 }]),
          modifiers: modifierRefs(promo.id),
          name: "Reserver",
          reservation_amount: "10%",
        },
        90,
      );
      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_discount_dep"),
        );
        expect([200, 302, 303]).toContain(response.status);

        const attendee = await latestAttendee();
        expect(attendee.remainingBalance).toBe(810);
        expect(await modifierUsageCount(promo.id)).toBe(1);
        expect(await modifierUsageAmount(promo.id)).toBe(100);

        const summary = await getAttendeeOrderSummary(attendee.id);
        expect(summary.depositPaid).toBe(90);
        expect(summary.fullPrice).toBe(900);

        const token = await signBalanceToken(attendee.id);
        const html = await (
          await handleRequest(mockRequest(`/pay/${token}`))
        ).text();
        expect(html).toContain("Full order price:</strong> £9");
        expect(html).toContain("Already paid:</strong> £0.90");
        expect(html).toContain("Balance due:</strong> £8.10");
      } finally {
        session.restore();
      }
    });

    test("keeps and refunds a sold-out reservation add-on as a quantity-0 placeholder", async () => {
      const listing = await setupReservationListing({
        bookingFee: "0",
        reservationAmount: "10%",
      });
      const addOn = await createProgrammeCharge({ stock: 0 });
      const refund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_addon", status: "succeeded" } as never),
      );
      const session = stubPaidSession(
        "cs_addon_sold",
        {
          _origin: "localhost",
          email: "reserver@example.com",
          items: JSON.stringify([{ e: listing.id, p: 1000, q: 1 }]),
          modifiers: modifierRefs(addOn.id),
          name: "Reserver",
          reservation_amount: "10%",
        },
        150,
      );
      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_addon_sold"),
        );
        // Signed by us → the sold-out add-on no longer drops the booking: it is
        // kept as a quantity-0 placeholder and refunded (HTTP 200), with the
        // reason recorded in a system note and the generic message to the buyer.
        expect(response.status).toBe(200);
        await expectRefundedPlaceholder(
          listing,
          addOn.id,
          refund,
          "pi_cs_addon_sold",
          await response.text(),
        );
        const { requirePaymentAggregateByProviderSession } = await import(
          "#test-utils/payment-aggregate.ts"
        );
        const payment = await requirePaymentAggregateByProviderSession(
          "cs_addon_sold",
        );
        expect(payment.completion?.kind).toBe("placeholder_refund");
        expect(payment.state).toBe("fully_refunded");
      } finally {
        session.restore();
        refund.restore();
      }
    });

    test("fails when no public-default status is configured", async () => {
      const listing = await setupReservationListing();
      // Clear the public-default flag so the required lookup fails.
      await getDb().execute(
        "UPDATE attendee_statuses SET is_public_default = 0",
      );
      attendeeStatuses.invalidate();
      await expect(captureCheckoutSnapshot(listing)).rejects.toThrow(
        "No attendee status has the required is_public_default flag",
      );
    });

    test("charges no deposit when the amount is zero, leaving the full balance", async () => {
      const listing = await setupReservationListing({
        bookingFee: "10",
        reservationAmount: "0",
      });
      // Deposit £0.00, fee 10% of the full £10.00 = £1.00 → total 100.
      const attendee = await bookPaidReservation(
        "cs_zero",
        {
          _origin: "localhost",
          email: "reserver@example.com",
          items: JSON.stringify([{ e: listing.id, p: 1000, q: 1 }]),
          name: "Reserver",
          reservation_amount: "0",
        },
        100,
      );
      // Gross sale leg is the full £10 even though £0 was collected up front;
      // the whole £10 is owed. (price_paid no longer tracks cash — concern 5.)
      expect(attendee.pricePaid).toBe(1000);
      expect(attendee.remainingBalance).toBe(1000);
      const summary = await getAttendeeOrderSummary(attendee.id);
      expect(summary.fullPrice).toBe(1100);
      expect(summary.reservationSubtotal).toBe(1000);
    });

    test("zero-deposit reservations without a fee skip the provider but keep the full balance", async () => {
      const listing = await setupReservationListing({ bookingFee: "0" });
      const statusId = await setPublicReservation("0");

      const attendee = await bookFreeOrder(listing);
      // Gross sale leg is the full £10 (provider skipped, £0 collected); the
      // whole £10 is owed. price_paid no longer tracks cash collected.
      expect(attendee.pricePaid).toBe(1000);
      expect(attendee.remainingBalance).toBe(1000);
      expect(attendee.statusId).toBe(statusId);
    });

    test("reservation discounts reduce the paid deposit and remaining balance", async () => {
      const listing = await setupReservationListing({ bookingFee: "0" });
      const statusId = await setPublicReservation("10%");
      const modifier = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 5,
        direction: "discount",
        name: "Discount",
      });
      const attendee = await bookPaidReservation(
        "cs_discounted_reservation",
        {
          _origin: "localhost",
          email: "reserver@example.com",
          items: JSON.stringify([{ e: listing.id, p: 1000, q: 1 }]),
          modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
          name: "Reserver",
          reservation_amount: "10%",
        },
        50,
      );
      // Gross sale leg (£10 list); the £5 discount and £0.50 deposit are
      // separate legs. The £4.50 owed stays accurate.
      expect(attendee.pricePaid).toBe(1000);
      expect(attendee.remainingBalance).toBe(450);
      expect(attendee.statusId).toBe(statusId);
    });
  },
);
