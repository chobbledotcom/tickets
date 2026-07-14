import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  revenueAccount,
  WORLD,
} from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import type { OrderBooking } from "#shared/booking-lines.ts";
import { activateStagedBooking } from "#shared/db/attendees/activate.ts";
import type { FinalizedBookingBatchPlan } from "#shared/db/attendees/create-batch.ts";
import { stageCheckout } from "#shared/db/checkout-stages.ts";
import { execute } from "#shared/db/client.ts";
import { reserveSession } from "#shared/db/processed-payments.ts";
import { runWithQueryLogContext } from "#shared/db/query-log.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

const CART_SIZE = 12;

describeWithEnv("db > staged large-cart activation", { db: true }, () => {
  test("activates a normal large cart without an input-sized transaction", async () => {
    const sessionId = "cs_activate_large_cart";
    const listings = [];
    for (let index = 0; index < CART_SIZE; index += 1) {
      listings.push(
        await createTestListing({
          maxAttendees: 10,
          name: `Large cart listing ${index}`,
          unitPrice: 1000,
        }),
      );
    }
    const intent = checkoutIntent({
      items: listings.map((listing) =>
        checkoutItem({
          listingId: listing.id,
          name: listing.name,
          slug: listing.slug,
        }),
      ),
    });
    const stage = await stageCheckout(sessionId, "stripe", intent);
    await reserveSession(sessionId);
    const bookings: OrderBooking[] = listings.map((listing) => ({
      date: null,
      durationDays: 1,
      listingId: listing.id,
      pricePaid: 1000,
      quantity: 1,
    }));
    const occurredAt = "2026-07-14T12:00:00.000Z";
    const eventGroup = "large-cart-event";
    const sales: TransferInput[] = listings.map((listing, index) => ({
      amount: 1000,
      destination: revenueAccount(listing.id),
      eventGroup,
      kind: KIND.sale,
      occurredAt,
      reference: `large-cart-sale-${index}`,
      source: attendeeAccount(stage.attendeeId),
    }));
    const plan: FinalizedBookingBatchPlan = {
      finalize: { paymentReference: "pi_large_cart", sessionId },
      legs: [
        ...sales,
        {
          amount: CART_SIZE * 1000,
          destination: attendeeAccount(stage.attendeeId),
          eventGroup,
          kind: KIND.payment,
          occurredAt,
          reference: "large-cart-payment",
          source: WORLD,
        },
      ],
      usages: [],
    };

    const activated = await runWithQueryLogContext(() =>
      activateStagedBooking(
        sessionId,
        stage.attendeeId,
        stage.ticketToken,
        {
          address: intent.address,
          bookings,
          email: intent.email,
          name: intent.name,
          paymentId: "pi_large_cart",
          phone: intent.phone,
          special_instructions: intent.special_instructions,
        },
        plan,
      ),
    );

    expect(activated).toEqual({ success: true });
    const result = await execute(
      `SELECT COUNT(*) AS booking_count, SUM(quantity) AS quantity
         FROM listing_attendees WHERE attendee_id = ?`,
      [stage.attendeeId],
    );
    expect(result.rows.map((row) => [row.booking_count, row.quantity])).toEqual(
      [[CART_SIZE, CART_SIZE]],
    );
    const legs = await execute(
      "SELECT COUNT(*) AS leg_count FROM transfers WHERE event_group = ?",
      [eventGroup],
    );
    expect(legs.rows[0]!.leg_count).toBe(CART_SIZE + 1);
  });
});
