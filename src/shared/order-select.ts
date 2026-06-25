/**
 * Shared field-name scheme for selecting listings with hidden checkboxes.
 *
 * Used by the public `/order` gallery and the admin calendar availability
 * checker so both speak the same wire format: a checked box submits
 * `select_<listingId>=1`, and an optional `start_date` carries the anchor date
 * the selection was made for. The admin attendee and servicing create forms use
 * the shared readers here to pre-fill the chosen listings.
 */

import { isIsoDate } from "#shared/validation/date.ts";
import { parsePositiveIntId } from "#shared/validation/number.ts";

export const SELECT_PREFIX = "select_";
export const START_DATE_FIELD = "start_date";

/**
 * Extract selected listing ids from `select_<id>=1` params, de-duplicated and
 * in ascending id order. Values other than "1" and ids that aren't strict
 * positive integers are ignored, so a hand-crafted query can't smuggle in junk.
 */
export const parseSelectedListingIds = (params: URLSearchParams): number[] => {
  const ids = new Set<number>();
  for (const [key, value] of params) {
    if (!key.startsWith(SELECT_PREFIX) || value !== "1") continue;
    const id = parsePositiveIntId(key.slice(SELECT_PREFIX.length));
    if (id !== null) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
};

export const selectedListingQuantities = (
  params: URLSearchParams,
): Map<number, number> =>
  new Map(parseSelectedListingIds(params).map((id) => [id, 1]));

export const selectedStartDate = (params: URLSearchParams): string => {
  const start = params.get(START_DATE_FIELD) ?? "";
  return isIsoDate(start) ? start : "";
};
