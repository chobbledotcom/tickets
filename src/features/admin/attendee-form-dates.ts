/**
 * Shared dates and stored bookings derived from the attendee form's listing
 * lines.
 *
 * The form holds one shared date range for every daily listing the attendee
 * books. These helpers read that range out of the attendee's existing booking
 * rows. They project the form's lines into the read-only booking summaries the
 * attendee page shows.
 */

import type { ListingAttendeeRow } from "#db/attendee-types.ts";
import { mapNotNullish } from "#fp";
import type { AttendeeFormLine } from "#routes/admin/attendee-form-model.ts";
import { DAY_MS } from "#shared/now.ts";

/**
 * A read-only summary of one listing the attendee currently books — quantity,
 * dates, status — shown in the bookings table at the top of the edit page.
 */
export type AttendeeBooking = {
  assignBuiltSite: boolean;
  listingId: number;
  listingName: string;
  listingActive: boolean;
  quantity: number;
  startAt: string | null;
  endAt: string | null;
  checkedIn: number;
  refunded: boolean;
  /** The parent listing this booking was chosen under as an add-on (a folded
   * child), or 0 when it is an ordinary standalone booking. */
  parentListingId: number;
};

/** The shared date range implied by an attendee's existing daily bookings. */
export type SharedDates = {
  /** Shared start date (YYYY-MM-DD), or "" when there are no daily bookings. */
  startDate: string;
  /** Shared day count (≥ 1). */
  dayCount: number;
  /** True when the existing daily bookings disagree on start date or duration —
   * saving will normalise them all onto the one chosen range. */
  hasMixedTimings: boolean;
};

/** Whole-day span of a stored booking row, or null when it has no range. */
export const bookingDurationDays = (
  booking: ListingAttendeeRow,
): number | null => {
  if (!booking.start_at || !booking.end_at) return null;
  const ms =
    new Date(booking.end_at).getTime() - new Date(booking.start_at).getTime();
  const days = Math.round(ms / DAY_MS);
  return days >= 1 ? days : null;
};

/**
 * Project the form's listing lines into read-only booking summaries: one per
 * line that carries a saved booking (the attendee's current registrations),
 * dropping not-yet-booked rows. A booked line always resolves its listing.
 * The `listing` guard only keeps a hand-crafted POST — one pairing a saved
 * booking key with an unknown listing id — from throwing by dropping that
 * bogus line.
 */
export const attendeeBookingsFromLines = (
  lines: AttendeeFormLine[],
): AttendeeBooking[] =>
  mapNotNullish((line: AttendeeFormLine): AttendeeBooking | null => {
    const { existingBooking: booking, listing } = line;
    if (!booking || !listing) return null;
    return {
      assignBuiltSite: listing.assign_built_site,
      checkedIn: booking.checked_in,
      endAt: booking.end_at,
      listingActive: listing.active,
      listingId: line.listingId,
      listingName: listing.name,
      parentListingId: booking.parent_listing_id,
      quantity: booking.quantity,
      refunded: Boolean(booking.refunded),
      startAt: booking.start_at,
    };
  })(lines);

/**
 * Derive the shared date range from an attendee's existing bookings. Only dated
 * (daily) rows count. When they agree, that range is returned. When they
 * disagree, it seeds from the earliest start and longest duration and flags
 * mixed timings. The operator is then warned before saving normalises them.
 */
export const resolveSharedDates = (
  bookings: ListingAttendeeRow[],
): SharedDates => {
  const dated = bookings
    .filter((b) => b.start_at && b.end_at)
    .map((b) => ({
      duration: bookingDurationDays(b) ?? 1,
      startDate: b.start_at!.slice(0, 10),
    }));
  if (dated.length === 0) {
    return { dayCount: 1, hasMixedTimings: false, startDate: "" };
  }
  const first = dated[0]!;
  const allSame = dated.every(
    (d) => d.startDate === first.startDate && d.duration === first.duration,
  );
  if (allSame) {
    return {
      dayCount: first.duration,
      hasMixedTimings: false,
      startDate: first.startDate,
    };
  }
  return {
    dayCount: Math.max(...dated.map((d) => d.duration)),
    hasMixedTimings: true,
    startDate: [...dated.map((d) => d.startDate)].sort()[0]!,
  };
};
