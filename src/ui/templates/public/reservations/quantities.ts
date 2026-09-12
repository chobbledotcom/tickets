/** Quantity resolve/clamp helpers for the ticket form: deriving the pre-fill,
 * restoring a just-submitted value on a validation re-render, and clamping to
 * the allowed range. Shared by the per-listing and package-count restores so the
 * two can't drift. */

/* jscpd:ignore-start */
import {
  childQuantityFieldName,
  packageQuantityFieldName,
  quantityFieldName,
} from "#booking/tree.ts";
import { t } from "#i18n";
import { savedFormValue } from "#shared/forms/saved-data.ts";
import type { ListingWithCount } from "#types";
import type { TicketPrefill } from "./types.ts";
/* jscpd:ignore-end */

/** Labels each count with the months it buys on a built-site plan; undefined
 *  for ordinary listings, where the count is the month count already. One unit
 *  of a plan is its whole initial term, not one month — so a plain count would
 *  read as extra sites. */
export const monthLabelsForListing = (
  listing: Pick<ListingWithCount, "assign_built_site" | "initial_site_months">,
): ((count: number) => string) | undefined =>
  listing.assign_built_site
    ? (count) =>
        t("public.ticket.month_option", {
          count: count * listing.initial_site_months,
        })
    : undefined;

/** An `<option>` list `0..max` for a quantity selector, with `selected` chosen.
 *  `labelFor` names what each count buys (default: the count itself). */
export const quantityOptions = (
  max: number,
  selected: number,
  labelFor: (count: number) => string = String,
): string =>
  Array.from({ length: max + 1 }, (_, i) => i)
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
 * pre-fill — both clamped to the available range. */
export const restoredQuantity = (
  listingId: number,
  prefill: TicketPrefill | undefined,
  maxPurchasable: number,
): number =>
  clampSavedQuantity(
    savedFormValue(quantityFieldName(listingId)),
    maxPurchasable,
    resolveQuantity(prefill, maxPurchasable),
  );

/** One package's count to pre-select: the value the buyer just submitted
 * (restored when a validation error re-renders the page) clamped to the limit,
 * else 1 (or 0 when nothing can be ordered) — one bundle is also exactly what
 * an order-cart selection means. Without this an error would silently reset a
 * multi-package order to one, risking a wrong-quantity resubmit. */
export const restoredPackageQuantity = (
  groupId: number,
  limit: number,
): number =>
  clampSavedQuantity(
    savedFormValue(packageQuantityFieldName(groupId)),
    limit,
    Math.min(1, limit),
  );

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
