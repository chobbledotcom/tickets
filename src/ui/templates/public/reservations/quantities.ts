/** Quantity resolve/clamp helpers for the ticket form: deriving the pre-fill,
 * restoring a just-submitted value on a validation re-render, and clamping to
 * the allowed range. Shared by the per-listing and package-count restores so the
 * two can't drift. */

import { quantityBelowMin } from "#booking/model.ts";
/* jscpd:ignore-start */
import {
  childQuantityFieldName,
  packageQuantityFieldName,
  quantityFieldName,
} from "#booking/tree.ts";
import { t } from "#i18n";
import { savedFormValue } from "#shared/forms/saved-data.ts";
import { monthsPerUnitOf, resolvePurchaseUnit } from "#shared/purchase-unit.ts";
import type { ListingWithCount } from "#types";
import type { TicketPrefill } from "./types.ts";

/* jscpd:ignore-end */

/** The listing facts a month labeler reads: which kind of plan it is and the
 *  term each of its units buys. */
type MonthsListing = Pick<
  ListingWithCount,
  "assign_built_site" | "initial_site_months" | "months_per_unit"
>;

/** The months one priced unit buys, or undefined when a count is plain. The
 *  shared resolver decides. One unit of a plan prices its whole initial term.
 *  A renewal page prices the same listings by their months per unit. */
export const pricedMonthsForListing = (
  listing: MonthsListing,
  renewal?: boolean | undefined,
): number | undefined =>
  monthsPerUnitOf(resolvePurchaseUnit(listing, { renewal: renewal === true }));

/** Labels each count with the months it buys; undefined keeps the plain count.
 *  One unit of a plan prices its whole initial term (`initial_site_months`); a
 *  renewal page prices the same listings by their months per unit. */
export const monthLabelsForListing = (
  listing: MonthsListing,
  renewal?: boolean | undefined,
): ((count: number) => string) | undefined => {
  const monthsEach = pricedMonthsForListing(listing, renewal);
  return monthsEach === undefined
    ? undefined
    : (count) => t("public.ticket.month_option", { count: count * monthsEach });
};

/** An `<option>` list for a quantity selector: none (0), then `minimum..max`,
 *  with `selected` chosen. `minimum` defaults to 1, which keeps the plain
 *  `0..max` list. `labelFor` names what each count buys (default: the count). */
export const quantityOptions = (
  max: number,
  selected: number,
  labelFor: (count: number) => string = String,
  minimum = 1,
): string =>
  [
    0,
    ...Array.from(
      { length: Math.max(0, max - minimum + 1) },
      (_, i) => i + minimum,
    ),
  ]
    .map(
      (n) =>
        `<option value="${n}"${
          n === selected ? " selected" : ""
        }>${labelFor(n)}</option>`,
    )
    .join("");

/** The pre-filled quantity, clamped to the allowed range. */
const resolveQuantity = (
  prefill: TicketPrefill | undefined,
  maxPurchasable: number,
): number => {
  if (!prefill?.quantity) return 0;
  return Math.max(0, Math.min(prefill.quantity, maxPurchasable));
};

/** Clamp a just-submitted numeric form value to `[0, max]`, falling back to
 * `fallback` when the field was absent (`""`). Shared by the per-listing and
 * package-count restores so the two can't drift. */
const clampSavedQuantity = (
  saved: string,
  max: number,
  fallback: number,
): number =>
  saved === ""
    ? fallback
    : Math.max(0, Math.min(Number.parseInt(saved, 10) || 0, max));

/** The quantity to pre-select for a row: the value the visitor just submitted
 * (restored when a validation error re-renders the page), else the QR/order
 * pre-fill — both clamped to the available range, and a count above none but
 * below the minimum restores to 0 so a re-render or a stale prefill never
 * selects a value the select does not offer. */
export const restoredQuantity = (
  listingId: number,
  prefill: TicketPrefill | undefined,
  maxPurchasable: number,
  minQuantity: number,
): number => {
  const restored = clampSavedQuantity(
    savedFormValue(quantityFieldName(listingId)),
    maxPurchasable,
    resolveQuantity(prefill, maxPurchasable),
  );
  return quantityBelowMin(restored, minQuantity) ? 0 : restored;
};

/** One package's count to pre-select: the value the buyer just submitted
 *  (restored when a validation error re-renders the page) clamped to the
 *  limit, else the members' joint bundle floor (or 0 when nothing can be
 *  ordered). The select offers none plus the floor upward, so the fresh
 *  default must be one of its options, and a restored count below the floor —
 *  the owner raised it while this form was open — snaps to zero, exactly as
 *  the row restore does for a listing minimum. */
export const restoredPackageQuantity = (
  groupId: number,
  limit: number,
  bundleMinimum = 1,
): number => {
  const restored = clampSavedQuantity(
    savedFormValue(packageQuantityFieldName(groupId)),
    limit,
    Math.min(bundleMinimum, limit),
  );
  return quantityBelowMin(restored, bundleMinimum) ? 0 : restored;
};

/** The per-unit quantity restored for a child select after a validation
 * re-render: the buyer's submitted `child_qty_<parentId>_<childId>`, clamped to
 * `0..max`, else 0. */
export const restoredChildQty = (
  parentId: number,
  childId: number,
  max: number,
): number =>
  clampSavedQuantity(
    savedFormValue(childQuantityFieldName(parentId, childId)),
    max,
    0,
  );
