import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeAccount } from "#shared/accounting/accounts.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { deleteAttendee } from "#shared/db/attendees/delete.ts";
import { getOpenPaymentCases } from "#shared/db/payments/cases.ts";
import type { PaymentSession } from "#shared/db/payments/types.ts";
import { finishQueuedBulkRefund } from "#shared/payment-runtime/bulk-refund.ts";
import type { Attendee } from "#shared/types.ts";
import { refundLegsOf } from "#test/shared/refund-ledger/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import {
  createAggregatePayment,
  getPaymentAggregateOrNull,
} from "#test-utils/payment-aggregate.ts";
import { required } from "#test-utils/required.ts";
import { setupStripe } from "#test-utils/settings.ts";

const PRICE = 1_000;

/** One person who booked and paid, with the sale on the books. */
const bookedAndPaid = async (
  email: string,
  postSale: boolean,
): Promise<Attendee> => {
  await setupStripe();
  const listing = await createTestListing({ maxAttendees: 100 });
  const created = await attendeesApi.createAttendeeAtomic({
    bookings: [{ listingId: listing.id, pricePaid: PRICE, quantity: 1 }],
    email,
    name: "Bulk refund buyer",
    paymentId: `pi-${email}`,
  });
  if (!created.success) throw new Error("Could not make the test booking");
  const attendee = created.attendees[0]!;
  if (postSale) {
    await postListingSale({
      amountPaid: PRICE,
      attendeeId: attendee.id,
      eventId: `sale-${email}`,
      gross: PRICE,
      listingId: listing.id,
    });
  }
  return attendee;
};

/** A payment for this person, with all or none of its money given back. */
const paymentFor = async (
  attendeeId: number,
  paymentId: string,
  refunded: boolean,
): Promise<PaymentSession> =>
  (
    await createAggregatePayment({
      attendeeId,
      charges: [
        {
          amount: PRICE,
          reference: `ch-${paymentId}`,
          ...(refunded ? { refundedAmount: PRICE } : {}),
        },
      ],
      configuredAccount: true,
      paymentId,
    })
  ).payment;

/** Every refund line written against this person. */
const refundLegsFor = async (attendeeId: number) =>
  refundLegsOf(await transfersByAccount(attendeeAccount(attendeeId)));

describeWithEnv("finishing a queued bulk refund", { db: true }, () => {
  test("waits while another payment for the same person still has money", async () => {
    // Both payments were queued together. The first one back must not write
    // the refund down on its own, or the books would say the person was paid
    // back in full while the second payment is still sitting at the provider.
    const attendee = await bookedAndPaid("two-payments@example.com", true);
    const givenBack = await paymentFor(attendee.id, "bulk-refunded", true);
    await paymentFor(attendee.id, "bulk-still-held", false);

    await finishQueuedBulkRefund(givenBack);

    expect(await refundLegsFor(attendee.id)).toEqual([]);
    // Nothing is wrong yet either, so the owner is not asked to look.
    expect(await getOpenPaymentCases()).toEqual([]);
  });

  test("asks the owner to look when the books will not take the refund", async () => {
    // The provider gave the money back, but this person's sale was never put
    // on the books, so there is nothing for the refund to reverse. That is a
    // real mismatch, so it goes in front of the owner instead of passing.
    const attendee = await bookedAndPaid("no-sale@example.com", false);
    const givenBack = await paymentFor(attendee.id, "bulk-no-sale", true);

    await finishQueuedBulkRefund(givenBack);

    expect(await refundLegsFor(attendee.id)).toEqual([]);
    expect(await getOpenPaymentCases()).toMatchObject([
      { paymentId: givenBack.id, state: "needs_action" },
    ]);
  });

  test("refuses a queued refund whose person is gone", async () => {
    // Deleting someone leaves their payments behind with nobody on them. If
    // that happens while their refund is still waiting at the provider, there
    // is nobody to write the money back to, and saying so beats dropping it.
    const attendee = await bookedAndPaid("deleted@example.com", true);
    await paymentFor(attendee.id, "bulk-orphan", true);
    await deleteAttendee(attendee.id);
    const detached = required(
      await getPaymentAggregateOrNull("bulk-orphan"),
      "the payment left behind",
    );

    expect(detached.attendeeId).toBeNull();
    await expect(finishQueuedBulkRefund(detached)).rejects.toThrow(
      "has no attendee",
    );
  });
});
