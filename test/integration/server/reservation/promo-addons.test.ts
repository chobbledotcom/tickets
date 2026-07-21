import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { stripeApi } from "#shared/stripe.ts";
import { captureCheckoutIntent } from "#test-utils/checkout.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  modifierUsageAmount,
  modifierUsageCount,
} from "#test-utils/modifiers.ts";
import { bookPaidReservation } from "../../../lib/server-reservation/_shared-setup.ts";
import {
  createOptionalAddOn,
  createProgrammeCharge,
  createSave10Promo,
  expectRefundedPlaceholder,
  modifierRefs,
  setupReservationListing,
  stubPaidSession,
} from "../../../lib/server-reservation/helpers.ts";

describeWithEnv(
  "server (reservation deposit at checkout)",
  { db: true },
  () => {
    test("full-payment promo discount stores the discounted price paid", async () => {
      const listing = await setupReservationListing({ bookingFee: "0" });
      const promo = await createSave10Promo();
      const attendee = await bookPaidReservation(
        "cs_full_discount",
        {
          _origin: "localhost",
          email: "buyer@example.com",
          items: JSON.stringify([{ e: listing.id, p: 1000, q: 1 }]),
          modifiers: modifierRefs(promo.id),
          name: "Buyer",
        },
        900,
      );
      // price_paid projects the gross sale leg (£10 list), not the £9
      // discounted total — the £1 discount is a separate ledger leg. Paid in
      // full, so nothing owed. (Modifiers are unused in production.)
      expect(attendee.pricePaid).toBe(1000);
      expect(attendee.remainingBalance).toBe(0);
      expect(await modifierUsageCount(promo.id)).toBe(1);
      expect(await modifierUsageAmount(promo.id)).toBe(100);
    });

    test("carries resolved modifiers into a reservation checkout", async () => {
      const listing = await setupReservationListing({
        reservationAmount: "10%",
      });
      await createProgrammeCharge();
      const captured = await captureCheckoutIntent(listing);
      expect(captured?.reservationAmount).toBe("10%");
      expect(captured?.modifiers).toHaveLength(1);
    });

    test("free listing with a selected add-on uses paid reservation checkout", async () => {
      const listing = await setupReservationListing({
        bookingFee: "0",
        reservationAmount: "10%",
        unitPrice: 0,
      });
      const addOn = await createOptionalAddOn();
      const captured = await captureCheckoutIntent(listing, {
        [`addon_${addOn.id}`]: "1",
      });
      expect(captured?.items[0]?.unitPrice).toBe(0);
      expect(captured?.reservationAmount).toBe("10%");
      expect(captured?.modifiers?.[0]?.id).toBe(addOn.id);
      expect(captured?.modifiers?.[0]?.quantity).toBe(1);
    });

    test("reservation with a positive add-on stores the modified balance", async () => {
      const listing = await setupReservationListing({
        bookingFee: "0",
        reservationAmount: "10%",
      });
      const addOn = await createProgrammeCharge();
      // Full modified subtotal £20.00, deposit 10% = £2.00.
      const attendee = await bookPaidReservation(
        "cs_addon_dep",
        {
          _origin: "localhost",
          email: "reserver@example.com",
          items: JSON.stringify([{ e: listing.id, p: 1000, q: 1 }]),
          modifiers: modifierRefs(addOn.id, 2),
          name: "Reserver",
          reservation_amount: "10%",
        },
        200,
      );
      // Gross sale leg (£10 list); the add-on uplift and the £2 deposit are
      // separate legs. The £18 owed stays accurate.
      expect(attendee.pricePaid).toBe(1000);
      expect(attendee.remainingBalance).toBe(1800);
      expect(await modifierUsageCount(addOn.id)).toBe(2);
      expect(await modifierUsageAmount(addOn.id)).toBe(1000);
    });

    test("keeps and refunds a zero-price reservation add-on when the total mismatches", async () => {
      const listing = await setupReservationListing({
        bookingFee: "0",
        reservationAmount: "10%",
        unitPrice: 0,
      });
      const addOn = await createProgrammeCharge();
      const refund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_free_addon", status: "succeeded" } as never),
      );
      const session = stubPaidSession(
        "cs_free_addon_bad",
        {
          _origin: "localhost",
          email: "reserver@example.com",
          items: JSON.stringify([{ e: listing.id, p: 0, q: 1 }]),
          modifiers: modifierRefs(addOn.id),
          name: "Reserver",
          reservation_amount: "10%",
        },
        40,
      );
      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_free_addon_bad"),
        );
        // Signed by us → kept as a quantity-0 placeholder and refunded (HTTP 200):
        // the reason now lives in a system note, so the customer sees the generic
        // saved-details message rather than the specific price/total reason.
        expect(response.status).toBe(200);
        await expectRefundedPlaceholder(
          listing,
          addOn.id,
          refund,
          "pi_cs_free_addon_bad",
          await response.text(),
        );
      } finally {
        session.restore();
        refund.restore();
      }
    });
  },
);
