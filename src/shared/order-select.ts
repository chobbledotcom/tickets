/**
 * Shared field-name scheme for selecting listings and packages with hidden
 * checkboxes.
 *
 * Used by the public `/order` gallery and the admin calendar availability
 * checker so both speak the same wire format: a checked box submits
 * `select_<listingId>=1` (or `select_package_<groupId>=1` for a package), an
 * optional `start_date` carries the anchor date the selection was made for,
 * and an optional `order` field carries the order the visitor added things in
 * (option keys, comma-separated) so availability messages can honour earlier
 * choices. The admin attendee and servicing create forms use the shared
 * readers here to pre-fill the chosen listings.
 */

import { listingOptionKey, packageOptionKey } from "#shared/order/options.ts";
import { isIsoDate } from "#shared/validation/date.ts";
import { parsePositiveIntId } from "#shared/validation/number.ts";

export const SELECT_PREFIX = "select_";
export const PACKAGE_SELECT_PREFIX = "select_package_";
export const START_DATE_FIELD = "start_date";
export const ORDER_FIELD = "order";

/** Extract ids from `prefix<id>=1` params, de-duplicated and ascending.
 * Values other than "1" and ids that aren't strict positive integers are
 * ignored, so a hand-crafted query can't smuggle in junk. */
const parseSelectedIds = (
  params: URLSearchParams,
  prefix: string,
  exclude?: string,
): number[] => {
  const ids = new Set<number>();
  for (const [key, value] of params) {
    if (!key.startsWith(prefix) || value !== "1") continue;
    if (exclude !== undefined && key.startsWith(exclude)) continue;
    const id = parsePositiveIntId(key.slice(prefix.length));
    if (id !== null) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
};

/** Selected listing ids from `select_<id>=1` params (package selections use
 * their own prefix and never parse as listing ids). */
export const parseSelectedListingIds = (params: URLSearchParams): number[] =>
  parseSelectedIds(params, SELECT_PREFIX, PACKAGE_SELECT_PREFIX);

/** Selected package group ids from `select_package_<groupId>=1` params. */
export const parseSelectedPackageIds = (params: URLSearchParams): number[] =>
  parseSelectedIds(params, PACKAGE_SELECT_PREFIX);

export const selectedListingQuantities = (
  params: URLSearchParams,
): Map<number, number> =>
  new Map(parseSelectedListingIds(params).map((id) => [id, 1]));

export const selectedStartDate = (params: URLSearchParams): string => {
  const start = params.get(START_DATE_FIELD) ?? "";
  return isIsoDate(start) ? start : "";
};

/**
 * The selection as ordered option keys ("listing:5", "package:3"): the
 * `order` field's sequence wins for the keys it names (the order things were
 * added, maintained client-side), and any selected key it misses is appended
 * in id order — so a visitor without JavaScript still gets a deterministic
 * order, and a tampered `order` value can neither add nor keep an unselected
 * key.
 */
export const orderedSelectionKeys = (params: URLSearchParams): string[] => {
  const selected = new Set([
    ...parseSelectedListingIds(params).map(listingOptionKey),
    ...parseSelectedPackageIds(params).map(packageOptionKey),
  ]);
  const ordered: string[] = [];
  for (const key of (params.get(ORDER_FIELD) ?? "").split(",")) {
    if (selected.has(key)) {
      ordered.push(key);
      selected.delete(key);
    }
  }
  return [...ordered, ...selected];
};
