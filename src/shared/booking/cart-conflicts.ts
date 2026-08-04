/**
 * Why a page selling several things together has no date or booking length to
 * offer. The booking form only offers the dates and lengths EVERY item
 * supports, so two items with no overlap leave the buyer a bare "nothing is
 * available" with no way to tell which items clash. These rules name them.
 *
 * Pure and render-time only: the ticket page evaluates the rules against each
 * item's own dates and lengths (gathered by `dailyDateItems` in
 * `features/public/ticket-payment.ts` and `customisableLengthItems` in
 * `#shared/booking/model.ts`) and shows every conflict at once via
 * `allReasons`. When no rule speaks — one item, or an overlap emptied some
 * other way — the selectors keep their plain "nothing available" copy.
 */

import { intersect } from "@std/collections";
import { t } from "#i18n";
import { nameList } from "#shared/name-list.ts";
import { allReasons, type Reason } from "#shared/reasons.ts";

/** One page item and the start dates it can offer on its own. The id lets the
 * render path drop items whose names must stay hidden (concealed package
 * members) before any message names them. */
export type CartDateItem = {
  id: number;
  name: string;
  dates: readonly string[];
};

/** One page item and the booking lengths it supports on its own. */
export type CartLengthItem = { name: string; dayCounts: readonly number[] };

/** What the conflict rules read: each item's own dates and booking lengths,
 * before the page narrows them to what all items share. */
export type CartFacts = {
  dateItems: readonly CartDateItem[];
  lengthItems: readonly CartLengthItem[];
};

/** Each name quoted for a sentence: 'Hall', 'Boat' and 'Marquee'. */
const quotedNames = (items: readonly { name: string }[]): string =>
  nameList(items.map((item) => `'${item.name}'`));

/** True when several items each offer something but nothing suits them all. */
const nothingShared = <T>(offers: readonly (readonly T[])[]): boolean =>
  offers.length >= 2 &&
  offers.every((offer) => offer.length > 0) &&
  intersect(...offers).length === 0;

/** The conflict rules, in display order. Each speaks only when it can name the
 * clash; anything else falls back to the selectors' plain empty copy. */
const CART_CONFLICT_REASONS: readonly Reason<[CartFacts]>[] = [
  // An item with no dates of its own: the problem is that item, not the mix.
  // When EVERY item is dateless there are no "others" left to book, so the
  // message would give an impossible instruction — the selector's plain "no
  // dates" copy covers that case instead.
  ({ dateItems }) => {
    if (dateItems.length < 2) return null;
    const dateless = dateItems.filter((item) => item.dates.length === 0);
    return dateless.length > 0 && dateless.length < dateItems.length
      ? t("public.ticket.cart_item_no_dates", {
          count: dateless.length,
          names: quotedNames(dateless),
        })
      : null;
  },
  // Every item has dates, but no single date works for all of them.
  ({ dateItems }) =>
    nothingShared(dateItems.map((item) => item.dates))
      ? t("public.ticket.cart_no_shared_date", {
          names: quotedNames(dateItems),
        })
      : null,
  // Every customisable item has lengths, but no length works for all of them.
  ({ lengthItems }) =>
    nothingShared(lengthItems.map((item) => item.dayCounts))
      ? t("public.ticket.cart_no_shared_length", {
          names: quotedNames(lengthItems),
        })
      : null,
];

/** Every conflict stopping these items being booked together, in display
 * order — empty when the items get along (or the page sells one thing). */
export const cartConflictMessages = (facts: CartFacts): string[] =>
  allReasons(CART_CONFLICT_REASONS)(facts);
