import { filter, mapNotNullish, pipe } from "#fp";
import { t } from "#i18n";
import { childDaysFromParent } from "#shared/booking/model.ts";
import { formatCurrency } from "#shared/currency.ts";
import {
  availableDayCounts,
  dayPriceFor,
  type ListingWithCount,
} from "#shared/types.ts";

/** The duration a customisable child inherits at no-JS render, or null when the
 * parent is itself customisable (the buyer hasn't yet chosen a day count, so
 * there is no single render-time duration). Specialises the shared
 * {@link childDaysFromParent}: customisable → null, standard → 1. */
const parentRenderDuration = (parent: ListingWithCount): number | null =>
  childDaysFromParent<number | null>(parent, null, 1);

/** The "from" price for a customisable child under a customisable parent: the
 * minimum child day price over the spans the parent can ACTUALLY offer (parent's
 * selectable counts ∩ child's priced counts). Using the child's own lowest span
 * ignores the parent's range, so a parent offering only {3} days with a child
 * priced {1:£10, 3:£25} would advertise "from £10" while checkout (inheriting the
 * 3-day span) charges £25. Returns null when the spans don't intersect
 * (such an edge isn't bookable anyway), so the label is omitted. */
const childFromPrice = (
  child: ListingWithCount,
  parent: ListingWithCount,
): number | null => {
  const childSpans = new Set(availableDayCounts(child));
  const prices = pipe(
    filter((n: number) => childSpans.has(n)),
    mapNotNullish((n) => dayPriceFor(child, n)),
  )(availableDayCounts(parent));
  return prices.length === 0 ? null : Math.min(...prices);
};

/** The numeric price shown for a child under a parent, in minor units, or null
 * when the child has no price for the inherited / overlapping span (defensive —
 * admin blocks such edges). A customisable child is priced by the inherited
 * duration, NOT its `unit_price` (0 for a free-input customisable listing, which
 * would advertise "free" while checkout charges the day price): the fixed
 * inherited day price under a fixed-duration parent, or the minimum day price over
 * the parent∩child spans under a customisable parent. A fixed-price child returns
 * its `unit_price` unchanged. The single source of truth both the label below and
 * the render-time "all free" check consume. */
export const childPriceMinor = (
  child: ListingWithCount,
  parent: ListingWithCount,
): number | null => {
  if (!child.customisable_days) return child.unit_price;
  const duration = parentRenderDuration(parent);
  // Customisable parent, no single duration yet: price by the cheapest span the
  // parent can actually offer (parent∩child counts).
  // A fixed-duration parent prices the child at the inherited duration;
  // `dayPriceFor` returns null for an out-of-range span ⇒ null (admin blocks an
  // unpriced inherited span).
  return duration === null
    ? childFromPrice(child, parent)
    : dayPriceFor(child, duration);
};

/** The price label shown in a child option's label: `(£X)` for a fixed/inherited
 * price, or `from £X` for a customisable child under a customisable parent (no
 * single render-time duration yet). Omitted (empty) when the child has no price for
 * the inherited / overlapping span, or — when `showZero` is false — when the price
 * is exactly £0. The block hides every child's price when ALL bookable children are
 * free, so a solo free child shows no "(£0)" and an all-free selector drops every
 * price; one paid sibling among free children keeps all prices (including the £0
 * ones) so the buyer can compare. */
export const childPriceLabel = (
  child: ListingWithCount,
  parent: ListingWithCount,
  showZero = true,
): string => {
  const price = childPriceMinor(child, parent);
  if (price === null) return "";
  if (price === 0 && !showZero) return "";
  // A customisable child under a customisable parent (no single duration yet)
  // advertises "from <min day price>"; every other case shows the fixed price.
  if (child.customisable_days && parentRenderDuration(parent) === null) {
    return t("public.ticket.child_from_price", {
      price: formatCurrency(price),
    });
  }
  return `(${formatCurrency(price)})`;
};
