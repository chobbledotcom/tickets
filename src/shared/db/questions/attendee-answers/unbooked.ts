/**
 * Answers filed under a listing the order never booked.
 *
 * Checkout files a buyer's answers under the listing they belong to, keyed by
 * the listing id. Both saves then look each booked listing up in that map, so
 * a key naming a listing nobody booked matches nothing and the answers under
 * it are written nowhere. The booking is committed by the time the answers are
 * saved, so a stray key is reported and the rest of the answers still save.
 */

import type { AttendeeListingEntry } from "#db/questions/attendee-answers/save.ts";
import { unique } from "#fp";
import { ErrorCode, logError } from "#shared/logger.ts";

/**
 * Report every answer key that names a listing this order did not book.
 *
 * The check reads one way only. A booked listing with no questions has no key,
 * and one key can match several booked rows — a child allocated under two
 * parents, or a listing bought both in a package and on its own — so the two
 * counts differ on a healthy order.
 */
export const reportAnswersForUnbookedListings = (
  entries: readonly AttendeeListingEntry[],
  answerMaps: readonly (Record<string, unknown> | undefined)[],
): void => {
  const booked = new Set(entries.map(({ listing }) => String(listing.id)));
  const keys = unique(answerMaps.flatMap((map) => Object.keys(map ?? {})));
  for (const key of keys) {
    if (booked.has(key)) continue;
    logError({
      code: ErrorCode.DATA_INVALID,
      detail: `Answers name listing ${key}, which this order did not book`,
      listingId: Number(key),
    });
  }
};
