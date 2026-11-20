/** An attendee merge keeps each booking whose subscription still charges. */

import type { ListingAttendeeRow } from "#db/attendee-types.ts";
import { t } from "#i18n";
import { isCancellable } from "#payment/subscription-machine-spec.ts";
import type { AttendeeMergeDiffBookingItem } from "#shared/merge/attendee-merge-types.ts";

/** The booking a merge decision throws away: the target row a copied source
 * replaces, or the source row the merge does not copy. A moved row has no
 * target. */
const droppedBooking = (
  item: AttendeeMergeDiffBookingItem,
  copiesSource: boolean,
): ListingAttendeeRow | null =>
  copiesSource ? item.targetBooking : item.sourceBooking;

/** Errors for each decision that throws away a booking whose subscription
 * still charges. The owner cancels it first. */
export const droppedSubscriptionErrors = (
  items: readonly AttendeeMergeDiffBookingItem[],
  copiesSource: (item: AttendeeMergeDiffBookingItem) => boolean,
): string[] =>
  items
    .filter((item) => {
      const dropped = droppedBooking(item, copiesSource(item));
      return dropped !== null && isCancellable(dropped.subscription_status);
    })
    .map(
      (item) => `Listing #${item.listingId}: ${t("error.subscription_live")}`,
    );
