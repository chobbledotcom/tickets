import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { stripeApi } from "#shared/stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { getProcessedPayment } from "#test-utils/processed-payments.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { foundStripeIntent } from "#test-utils/stripe/responses.ts";
import { stubRefundPayment } from "#test-utils/webhooks/stripe.ts";
import {
  bookingIntent,
  expectStoredRefund,
  singleListingPayment,
  trustedPayment,
} from "./helpers.ts";

describeWithEnv("payment processing refund outcomes", { db: true }, () => {
  test("releases the reservation without repeating a rejected refund", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 5,
      unitPrice: 800,
    });
    await deactivateTestListing(listing.id);
    const id = "cs_direct_refund_retry";
    const data = trustedPayment(
      id,
      bookingIntent([{ e: listing.id, p: 800, q: 1 }]),
      800,
    );
    using refund = stub(stripeApi, "refundCharge", () =>
      Promise.resolve({ kind: "rejected", reason: "rejected" } as const),
    );
    using refundState = stub(stripeApi, "readPaymentIntent", () =>
      Promise.resolve(foundStripeIntent(data.session.paymentReference, 800)),
    );

    expect(await processPaymentSession(id, data)).toEqual({
      detail: undefined,
      error: "This listing is no longer accepting registrations.",
      refunded: false,
      status: 410,
      success: false,
    });
    expect(await getProcessedPayment(id)).toBeNull();
    expect(await processPaymentSession(id, data)).toMatchObject({
      refunded: false,
      success: false,
    });
    expect(refund.calls).toHaveLength(1);
    expect(refundState.calls).toHaveLength(2);
  });

  test("keeps a price-changed booking as a refunded placeholder", async () => {
    await setupStripe();
    const id = "cs_direct_price_changed";
    const { data, listing } = await singleListingPayment(id, 1000, 800);
    using refund = stubRefundPayment("re_price_changed", 800);

    const result = await processPaymentSession(id, data);
    await expectStoredRefund(
      result,
      {
        detail: `Per-item price mismatch for listing ${listing.id}: metadata p=800 but expected 1000 (can_pay_more=false)`,
        listingId: listing.id,
        sessionId: id,
      },
      refund,
    );
  });

  test("keeps and refunds a booking that loses the capacity race", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 1,
      unitPrice: 600,
    });
    const booked = await bookAttendee(listing, {
      email: "first@example.com",
      name: "First",
      paymentId: "pi_first",
      quantity: 1,
    });
    if (!booked.success) throw new Error("Failed to fill listing");
    const id = "cs_direct_capacity";
    using refund = stubRefundPayment("re_capacity", 600);

    const result = await processPaymentSession(
      id,
      trustedPayment(id, bookingIntent([{ e: listing.id, p: 600, q: 1 }]), 600),
    );
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected a capacity failure");
    expect(result.detail).toContain(
      "sold out while you were completing payment",
    );
    expect(
      (await getAttendeesRaw(listing.id)).map((row) => row.quantity).toSorted(),
    ).toEqual([0, 1]);
    expect(refund.calls).toHaveLength(1);
  });

  test("checks primary state before refunding an uncertain create", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 5,
      unitPrice: 500,
    });
    const id = "cs_direct_uncertain";
    using uncertain = stub(attendeesApi, "createBookingAtomic", () =>
      Promise.reject(new Error("write result unknown")),
    );
    using refund = stubRefundPayment("re_uncertain", 500);

    const result = await processPaymentSession(
      id,
      trustedPayment(id, bookingIntent([{ e: listing.id, p: 500, q: 1 }]), 500),
    );
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected recovery to refund");
    expect(result.detail).toBe(
      `Unexpected error completing session ${id}: Error: write result unknown`,
    );
    expect((await getAttendeesRaw(listing.id))[0]?.quantity).toBe(0);
    expect(uncertain.calls).toHaveLength(1);
    expect(refund.calls).toHaveLength(1);
  });
});
