import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { deleteAttendee } from "#shared/db/attendees/delete.ts";
import { getAttendeeOrNull } from "#shared/db/attendees/queries.ts";
import {
  getPaymentCharges,
  savePaymentCharges,
} from "#shared/db/payments/charges.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  createPausedAttendeePayment,
  expectAttendeePaymentFence,
} from "#test-utils/payment-aggregate.ts";

describeWithEnv("attendee deletion payment fence", { db: true }, () => {
  test("detaches stored payments and rejects a stale claim", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "Delete payment",
      "delete-payment@example.com",
    );
    const payment = await createPausedAttendeePayment(
      "delete-attendee-payment",
      attendee.id,
    );
    await savePaymentCharges(
      payment.payment.id,
      payment.session,
      [
        {
          captured: { amount: 100, currency: "GBP" },
          confirmedRefunded: { amount: 0, currency: "GBP" },
          refunds: [],
          resource: {
            id: "delete-attendee-charge",
            kind: "stripe_payment_intent",
            parentId: payment.session.id,
            provider: "stripe",
          },
        },
      ],
      payment.payment.createdAt,
    );

    await deleteAttendee(attendee.id);

    await expectAttendeePaymentFence(payment, attendee.id, null);
    expect(await getPaymentCharges(payment.payment.id)).toHaveLength(1);
    expect(
      await getAttendeeOrNull(attendee.id, await getTestPrivateKey()),
    ).toBeNull();
  });
});
