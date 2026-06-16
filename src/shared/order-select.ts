/**
 * Shared field-name scheme for selecting listings with hidden checkboxes.
 *
 * Used by the public `/order` gallery and the admin calendar availability
 * checker so both speak the same wire format: a checked box submits
 * `select_<listingId>=1`, and an optional `start_date` carries the anchor date
 * the selection was made for. `parseSelectedListingIds` reads the listing ids
 * back out — the create-attendee form uses it to pre-fill the chosen listings.
 */

export const SELECT_PREFIX = "select_";
export const START_DATE_FIELD = "start_date";

/**
 * Extract selected listing ids from `select_<id>=1` params, de-duplicated and
 * in ascending id order. Values other than "1" and unparseable ids are ignored,
 * so a hand-crafted query can't smuggle in junk.
 */
export const parseSelectedListingIds = (params: URLSearchParams): number[] => {
  const ids = new Set<number>();
  for (const [key, value] of params) {
    if (!key.startsWith(SELECT_PREFIX) || value !== "1") continue;
    const id = Number.parseInt(key.slice(SELECT_PREFIX.length), 10);
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
};
