/**
 * The payment-cancelled / declined page and its "try again" link.
 *
 * SumUp's hosted checkout has a single redirect URL for every outcome, so a card
 * decline lands on the same redirect as a cancel; both render this friendly page
 * rather than a "contact support" error.
 */

import { extractIntent } from "#routes/api/payment-processing/metadata.ts";
import type { BookingIntent } from "#routes/api/webhook-types.ts";
import { paymentErrorResponse } from "#routes/payment-response.ts";
import {
  getVisibleGroupMembers,
  groupBookable,
} from "#routes/public/group-liveness.ts";
import { lacksStandalonePublicPage } from "#routes/public/ticket-payment.ts";
import { htmlResponse } from "#routes/response.ts";
import { lineGroupIds } from "#shared/booking/signed-metadata.ts";
import { groups } from "#shared/db/groups.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import type {
  PaymentProvider,
  ValidatedPaymentSession,
} from "#shared/payments.ts";
import { tryCloseAndPurgeCheckoutStageBySession } from "#shared/staged-checkout.ts";
import { paymentCancelPage } from "#templates/payment.tsx";

type CancelLog = (detail: string) => void;

/** The retry link for a cancelled checkout: the package group's page when the
 * order booked one package, else the (first) listing's own page. Returns null
 * (no retry link) whenever the target page would no longer serve, so a "Try
 * again" link never dead-ends:
 *   - a standalone order whose listing has since lost its own booking page (it
 *     became a non-standalone child or a hidden package member mid-checkout);
 *   - a package order whose bundle is no longer bookable (a member was
 *     deactivated, or the package cap dropped to 0) — the same {@link
 *     groupBookable} gate the bundle page itself applies, so the link matches
 *     what `/ticket/<group>` would render. When the bundle is dead we fall back
 *     to the member's own page only if it still has one, else null.
 * An order that booked SEVERAL packages retries against the first bundle that
 * still serves (its page re-offers that part of the order), falling back like
 * the single-package case. */
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
    const group = await groups.table.findById(groupId);
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
  logFailure: CancelLog,
): Promise<Response> => {
  const intent = extractIntent(session);
  const listingId = intent?.items[0]?.e ?? 0;
  // Use getListingWithCount (not getListingWithCount) - we only need slug for the link
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

/** Close and clear a staged checkout, but keep the useful retry page on a
 * provider outage. The pending row remains for scheduled cleanup to retry. */
export const closeStageAndShowCancelPage = async (
  session: ValidatedPaymentSession,
  provider: PaymentProvider,
  logFailure: CancelLog,
): Promise<Response> => {
  await tryCloseAndPurgeCheckoutStageBySession(session.id, provider, (error) =>
    logFailure(
      `Could not close checkout stage ${session.id}: ${String(error)}`,
    ),
  );
  return cancelPageResponse(session, logFailure);
};
