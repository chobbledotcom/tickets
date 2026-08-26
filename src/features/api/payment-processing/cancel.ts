/**
 * The payment-cancelled / declined page and its "try again" link.
 *
 * SumUp's hosted checkout has a single redirect URL for every outcome, so a card
 * decline lands on the same redirect as a cancel; both render this friendly page
 * rather than a "contact support" error.
 */

import { lineGroupIds } from "#booking/signed-metadata.ts";
import { getGroupById } from "#db/groups.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { extractIntent } from "#routes/api/payment-processing/metadata.ts";
import { paymentErrorResponse } from "#routes/payment-response.ts";
import {
  getVisibleGroupMembers,
  groupBookable,
} from "#routes/public/group-liveness.ts";
import { lacksStandalonePublicPage } from "#routes/public/ticket-payment.ts";
import { htmlResponse } from "#routes/response.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import type { ValidatedPaymentSession } from "#shared/payments.ts";
import { paymentCancelPage } from "#templates/payment.tsx";

/** The retry link for a cancelled checkout. Returns null whenever the target
 * page would no longer serve, so a "Try again" link never dead-ends. A listing
 * can lose its own page mid-checkout, and a bundle can stop being bookable.
 * The gate is {@link groupBookable}, the same one `/ticket/<group>` applies, so
 * the link matches what that page would render. */
const retryHrefFor = async (
  intent: BookingIntent,
  listing: { id: number; slug: string },
): Promise<string | null> => {
  const standaloneHref = async () =>
    (await lacksStandalonePublicPage(listing.id))
      ? null
      : `/ticket/${listing.slug}`;
  const groupIds = lineGroupIds(intent.items);
  for (const groupId of groupIds) {
    const group = await getGroupById(groupId);
    const bundleServes =
      group !== null &&
      (await groupBookable(group, await getVisibleGroupMembers(group)));
    if (bundleServes) return `/ticket/${group.slug}`;
  }
  return standaloneHref();
};

/** Render the payment-cancelled page for a session's first listing. */
export const cancelPageResponse = async (
  session: ValidatedPaymentSession,
  logFailure: (detail: string) => void,
): Promise<Response> => {
  const intent = extractIntent(session);
  const listingId = intent?.items[0]?.e ?? 0;
  const listing = await getListingWithCount(listingId);
  if (!listing) {
    logFailure(
      `Listing not found (session=${session.id}, listingId=${listingId})`,
    );
    return paymentErrorResponse("Listing not found", 404);
  }
  // A package checkout retries against the bundle's own page, not a member's
  // standalone page (which may hide members or use override prices/quantities).
  // A null intent reads listing id 0, which never resolves — so reaching here
  // proves the intent parsed.
  const retryHref = await retryHrefFor(intent!, listing);
  return htmlResponse(paymentCancelPage(listing, retryHref));
};
