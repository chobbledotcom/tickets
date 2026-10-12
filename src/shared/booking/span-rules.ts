/**
 * The declared span rules of booking. The one table says, per listing kind,
 * which spans it serves, which dates it can start, and which span a parent
 * books. Every surface derives its answers from this table: the booking
 * form's fold, the order gallery's judge, and the checkout availability
 * path. A new kind or a changed rule edits one place, and every consumer
 * learns it at once.
 *
 * Pure: no database, no settings. Callers hand in the listing row and the
 * active holidays.
 */

/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import type { Holiday } from "#db/holidays.ts";
import { getBookableStartDates, isBookingRangeValid } from "#shared/dates.ts";
import {
  availableDayCounts,
  clampDurationDays,
  type DayPricedListing,
  type Listing,
} from "#types";
/* jscpd:ignore-end */

/** The three kinds of listing span rules. A standard listing has no span of
 * days, and its stock is a running total. A fixed daily listing books its
 * own duration. A customisable daily listing books the day count the buyer
 * picks. */
export const ChildKindSchema = v.picklist([
  "standard",
  "daily_fixed",
  "daily_customisable",
]);
export type ChildKind = v.InferOutput<typeof ChildKindSchema>;

/** Which kind of span rules a listing follows. The day-price flag decides
 * first: every span rule that follows a day count reads it before the
 * listing type, as the form always has. */
export const childKindOf = (
  listing: Pick<Listing, "customisable_days" | "listing_type">,
): ChildKind => {
  if (listing.customisable_days) return "daily_customisable";
  return listing.listing_type === "daily" ? "daily_fixed" : "standard";
};

/** One kind's span rules. Each rule reads only the columns it needs. */
type SpanRule = {
  /** The day counts a child of this kind can serve, or null when it serves
   * any span. */
  readonly childSpans: (listing: DayPricedListing) => number[] | null;
  /** Whether the listing can start on `date` and hold `durationDays`. */
  readonly childDateOk: (
    listing: Listing,
    date: string,
    durationDays: number,
    holidays: Holiday[],
  ) => boolean;
  /** The day count a parent of this kind passes down: the buyer's choice when
   * the buyer picks the span, otherwise the listing's own. */
  readonly parentValue: <T>(
    listing: Pick<Listing, "duration_days">,
    whenCustomisable: T,
    whenStandard: T,
  ) => T;
  /** The span one directly-booked unit occupies while the buyer has not
   * picked a span. A fixed daily listing books its whole duration, and
   * anything else judges at one day. */
  readonly directSpanDays: (
    listing: Pick<
      Listing,
      "customisable_days" | "duration_days" | "listing_type"
    >,
  ) => number;
};

/** The declared table. A kind missing here is a compile error, never a
 * fallthrough. Every rule that follows a listing's kind lives in one cell. */
export const SPAN_RULES: Readonly<Record<ChildKind, SpanRule>> = {
  daily_customisable: {
    childDateOk: (listing, date, durationDays, holidays) =>
      // The form's date rule asks the listing type first: a listing judged
      // datelessly has no calendar, even when it prices day counts.
      listing.listing_type !== "daily" ||
      isBookingRangeValid(listing, date, durationDays, holidays),
    childSpans: (listing) => availableDayCounts(listing),
    directSpanDays: () => 1,
    parentValue: (_listing, whenCustomisable) => whenCustomisable,
  },
  daily_fixed: {
    childDateOk: (listing, date, _durationDays, holidays) =>
      getBookableStartDates(listing, holidays).includes(date),
    childSpans: (listing) => [clampDurationDays(listing.duration_days)],
    directSpanDays: (listing) => clampDurationDays(listing.duration_days),
    parentValue: <T>(listing: Pick<Listing, "duration_days">) =>
      clampDurationDays(listing.duration_days) as T,
  },
  standard: {
    childDateOk: () => true,
    childSpans: () => null,
    directSpanDays: () => 1,
    parentValue: (_listing, _whenCustomisable, whenStandard) => whenStandard,
  },
};
