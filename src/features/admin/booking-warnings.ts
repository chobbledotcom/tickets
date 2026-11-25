/**
 * Warnings the manual attendee form shows beside booked lines: over-duration
 * and overbooking. Both are allowed for admin saves, so they surface as
 * warnings, not errors. A parent booked without a child is a fact about the
 * saved booking, so the attendee page warns about it on every tab.
 */

import { checkLinesCapacity } from "#db/attendees/capacity/checks.ts";
import { compact, requiredMapValue } from "#fp";
import { t } from "#i18n";
import {
  type AttendeeFormLine,
  isBookedLine,
  type ParsedAttendeeForm,
} from "#routes/admin/attendee-form-model.ts";
import { isIsoDate } from "#shared/validation/date-string.ts";

/** A booked daily listing booked for longer than its own duration allows —
 * permitted (every daily listing shares one range), so a warning not an error. */
const overDurationWarning = (
  line: AttendeeFormLine,
  dayCount: number,
): string | null => {
  const listing = line.listing!;
  if (listing.listingType !== "daily" || dayCount <= listing.durationDays) {
    return null;
  }
  return t("attendee_form.warn_over_duration", {
    count: dayCount,
    max: listing.durationDays,
    title: listing.name,
  });
};

/** The capacity-check booking shape for one listing's TOTAL booked quantity
 * on the shared range (daily) or no date (standard). A listing booked through
 * two paths demands the SUM of its lines, so the overbook warning judges the
 * whole demand, not each path alone. */
const listingBookingFor = (
  line: AttendeeFormLine,
  quantity: number,
  parsed: ParsedAttendeeForm,
) => {
  const isDaily = line.listing!.listingType === "daily";
  return {
    date: isDaily ? parsed.startDate : null,
    durationDays: isDaily ? parsed.dayCount : 1,
    listingId: line.listingId,
    quantity,
  };
};

/** The set of booked listing ids that overbook capacity. The check is one
 * batched self-excluding pass (the same one the save uses) over each
 * listing's summed lines. A daily listing with no valid shared date is
 * skipped — the date error already blocks saving. */
const overbookedListingIds = async (
  booked: AttendeeFormLine[],
  parsed: ParsedAttendeeForm,
  excludeAttendeeId: number | undefined,
): Promise<Set<number>> => {
  const checkable = booked.filter(
    (line) =>
      line.listing!.listingType !== "daily" || isIsoDate(parsed.startDate),
  );
  const firstLineByListing = new Map<number, AttendeeFormLine>();
  const totalByListing = new Map<number, number>();
  for (const line of checkable) {
    if (!firstLineByListing.has(line.listingId)) {
      firstLineByListing.set(line.listingId, line);
    }
    totalByListing.set(
      line.listingId,
      (totalByListing.get(line.listingId) ?? 0) + line.quantity!,
    );
  }
  const perListing = [...firstLineByListing.values()];
  const fits = await checkLinesCapacity(
    perListing.map((line) =>
      listingBookingFor(
        line,
        requiredMapValue(totalByListing, line.listingId),
        parsed,
      ),
    ),
    excludeAttendeeId,
  );
  const overbooked = new Set<number>();
  for (const [i, line] of perListing.entries()) {
    if (!fits[i]) overbooked.add(line.listingId);
  }
  return overbooked;
};

/** Overbooking message for one listing's summed booked lines. */
const overbookMessage = (line: AttendeeFormLine, quantity: number): string =>
  t("attendee_form.warn_overbooked", {
    quantity,
    title: line.listing!.name,
  });

/**
 * Over-duration + overbooking warnings for every booked line, keyed by
 * listing id plus a flat list for the top-of-form summary. The capacity side
 * is one batched query for the whole form, not one per line.
 */
export const computeWarnings = async (
  parsed: ParsedAttendeeForm,
  excludeAttendeeId: number | undefined,
): Promise<{ byListing: Map<number, string[]>; top: string[] }> => {
  const booked = parsed.lines.filter(isBookedLine);
  const overbooked = await overbookedListingIds(
    booked,
    parsed,
    excludeAttendeeId,
  );
  const byListing = new Map<number, string[]>();
  const top: string[] = [];
  // One warning set per LISTING (its lines share capacity and the date range).
  // It attaches to the listing's first booked line and shows on each of its rows.
  const seenListings = new Set<number>();
  for (const line of booked) {
    if (seenListings.has(line.listingId)) continue;
    seenListings.add(line.listingId);
    const total = booked
      .filter((other) => other.listingId === line.listingId)
      .reduce((sum, other) => sum + other.quantity!, 0);
    const warns = compact([
      overDurationWarning(line, parsed.dayCount),
      overbooked.has(line.listingId) ? overbookMessage(line, total) : null,
    ]);
    if (warns.length > 0) {
      byListing.set(line.listingId, warns);
      top.push(...warns);
    }
  }
  return { byListing, top };
};
