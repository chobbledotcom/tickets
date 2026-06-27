/**
 * Pure compatibility rules for a single parent→child listing edge, shared by the
 * admin edge editor and the listing-save re-validation.
 *
 * A child has no date/duration controls of its own — it inherits the parent's —
 * so an edge is only honourable when neither side is a renewal tier, a daily
 * child sits under a daily parent, and the child's booking span can match the
 * duration it inherits from the parent. (Structural nesting checks — a child
 * that is also a parent — live with the editor, since a field edit can't create
 * them.)
 */

import { t } from "#i18n";
import {
  availableDayCounts,
  type DayPrices,
  dayPriceFor,
  normalizeDurationDays,
} from "#shared/types.ts";

/** The listing fields an edge-compatibility check reasons about. */
export type EdgeListing = {
  id: number;
  name: string;
  listing_type: string;
  months_per_unit: number;
  customisable_days: boolean;
  duration_days: number;
  day_prices: DayPrices;
};

/** A fixed-duration parent's single resolved booking span (days): its own
 * `duration_days` for a daily listing, otherwise 1. Only meaningful for a
 * non-`customisable_days` parent (a customisable parent has a *range*, via
 * {@link availableDayCounts}). */
const parentFixedDuration = (parent: EdgeListing): number =>
  parent.listing_type === "daily"
    ? normalizeDurationDays(parent.duration_days)
    : 1;

/**
 * Whether `child`'s booking span can match the duration it inherits from
 * `parent`. Only children that actually inherit a span need to agree with it:
 *
 * - a **plain standard** child (non-daily, non-customisable) folds as a
 *   `date: null`, one-day cumulative line and inherits **nothing** — so it fits
 *   under *any* parent (a one-off fee or merch add-on under a multi-day base);
 * - a **customisable** child must price the inherited span (overlapping a
 *   customisable parent's selectable range, or pricing a fixed parent's span);
 * - a **daily** child takes the parent's date+span, so its fixed `duration_days`
 *   must match the parent's fixed span or fall in a customisable parent's range.
 */
export const durationsCompatible = (
  parent: EdgeListing,
  child: EdgeListing,
): boolean => {
  if (child.customisable_days) {
    if (parent.customisable_days) {
      const childCounts = new Set(availableDayCounts(child));
      return availableDayCounts(parent).some((days) => childCounts.has(days));
    }
    return dayPriceFor(child, parentFixedDuration(parent)) !== null;
  }
  if (child.listing_type !== "daily") return true;
  const childDuration = normalizeDurationDays(child.duration_days);
  return parent.customisable_days
    ? availableDayCounts(parent).includes(childDuration)
    : childDuration === parentFixedDuration(parent);
};

/**
 * The user-facing error for a single parent→child edge whose listing *fields*
 * are incompatible (renewal tier on either side, a daily child under a non-daily
 * parent, or a span the child can't match), or null when the edge is allowed.
 * Field-only: structural nesting is checked separately by the editor.
 */
export const edgeFieldError = (
  parent: EdgeListing,
  child: EdgeListing,
): string | null => {
  if (parent.months_per_unit > 0) {
    return t("listings_table.children_err_parent_renewal", {
      name: parent.name,
    });
  }
  if (child.months_per_unit > 0) {
    return t("listings_table.children_err_child_renewal", { name: child.name });
  }
  if (child.listing_type === "daily" && parent.listing_type !== "daily") {
    return t("listings_table.children_err_child_daily", { name: child.name });
  }
  if (!durationsCompatible(parent, child)) {
    return t("listings_table.children_err_child_duration", {
      name: child.name,
    });
  }
  return null;
};
