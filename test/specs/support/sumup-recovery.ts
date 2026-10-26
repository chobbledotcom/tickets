/**
 * A payment whose callback was lost: the customer pays through SumUp on the
 * public booking page, but the site never hears about it — no callback, and
 * the customer never opens the payment link either, so nothing books the
 * payment. Only the site's scheduled maintenance can still ask SumUp about
 * the checkout it wrote down.
 */

import { expect } from "@std/expect";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import {
  openSumupHostedCheckout,
  type PublicPurchase,
  sellAndFillPublicBooking,
} from "#test/specs/support/refund-safety/journeys.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import {
  makeSumupCheckoutDue,
  withSumupCheckoutStatus,
} from "#test-utils/sumup.ts";

/** What the story holds about the payment the site never heard about. */
export interface LostSumupPayment {
  /** What SumUp took, in the currency's smallest unit. */
  readonly amountMinor: number;
  readonly listingId: number;
  /** The site's own checkout reference — the id in the payment link. */
  readonly reference: string;
}

/** The customer pays through the real public booking page and walks into
 * SumUp's hosted checkout — and the story stops there. No callback reaches
 * the site, and the customer never opens the payment link, so nothing books
 * the payment. SumUp is left holding the money, and the site's recovery row
 * is brought forward to its first check so maintenance asks at once. */
export const payThroughSumupWithoutTheSiteHearing = async (
  world: TicketsWorld,
  purchase: PublicPurchase,
): Promise<LostSumupPayment> => {
  const { filled, listing } = await sellAndFillPublicBooking(
    world,
    "sumup",
    purchase,
  );
  const checkoutId = `co_lost_${purchase.who.toLowerCase()}`;
  const { amountMinor, reference } = await openSumupHostedCheckout(
    filled,
    checkoutId,
  );
  // The row only becomes due hours after the checkout was created, so the
  // story brings its first check forward: waiting the real time out would
  // make maintenance skip it and the story would pass on nothing at all.
  await makeSumupCheckoutDue(checkoutId);
  return { amountMinor, listingId: listing.id, reference };
};

/** SumUp does hold the customer's money: asked about the checkout, it answers
 * that it was paid, by the amount it charged. The answer stays ready for the
 * rest of the scenario. */
export const sumupHoldsTheMoney = (
  world: TicketsWorld,
  payment: LostSumupPayment,
): void => {
  const paid = withSumupCheckoutStatus(payment.reference, "PAID", "txn_lost", {
    amountMinor: payment.amountMinor,
  });
  world.cleanup.add(() => paid.restore());
};

/** The payment is still sitting unbooked — nobody's name is on the listing. */
export const expectNothingBookedYet = async (
  listingId: number,
): Promise<void> => {
  expect(await getAttendeesRaw(listingId)).toEqual([]);
};
