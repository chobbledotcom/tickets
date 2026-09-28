/** The roster's check-in routes: the quantity page a multi-ticket line's
 * Check In / Check Out link opens, and the POST both that page and the
 * quantity 1 toggle submit. One module so the listing-scoped attendee routes
 * file stays under its line budget. */

import { ticketCount } from "#booking/ticket-moves.ts";
import { logActivity } from "#db/activity-log.ts";
import { hasActiveBookingLine } from "#db/attendees/queries.ts";
import { moveTickets } from "#db/attendees/update.ts";
import { requireSessionOr } from "#routes/auth.ts";
import { htmlResponse, redirect } from "#routes/response.ts";
import { getSearchParam } from "#routes/url.ts";
import type { FormParams } from "#shared/form-data.ts";
import { parsePositiveInt } from "#shared/validation/number.ts";
import { attendeeCheckinQuantityPage } from "#templates/admin/attendees/checkin-quantity.tsx";
import {
  attendeeBookingFormAction,
  getReturnUrl,
  withAttendeeBooking,
} from "./attendees-route-helpers.ts";
/** Return a redirect response when the attendee has no active booking line, or null otherwise. */
export const redirectIfNoActiveBookingLine = async (
  attendeeId: number,
  listingId: number,
  url: string,
  message: string,
  opts?: Parameters<typeof redirect>[3],
): Promise<Response | null> => {
  if (!(await hasActiveBookingLine(attendeeId, listingId))) {
    return redirect(url, message, false, opts);
  }
  return null;
};

/** Handle GET /admin/listing/:listingId/attendee/:attendeeId/checkin — the
 * quantity page a multi-ticket line's roster link opens. The same gate and
 * loader as the POST, so a link never promises a page the route refuses. */
export const handleAttendeeCheckinGet = (
  request: Request,
  { attendeeId, listingId }: { attendeeId: number; listingId: number },
): Promise<Response> =>
  requireSessionOr(request, (session) =>
    withAttendeeBooking(
      listingId,
      attendeeId,
    )(({ attendee, listing }) =>
      htmlResponse(
        attendeeCheckinQuantityPage({
          attendee,
          filter: getSearchParam(request, "return_filter"),
          listingName: listing.name,
          returnUrl: getReturnUrl(request),
          session,
        }),
      ),
    ),
  );

/** Where a roster action lands the operator: the threaded return_url, or the
 * Attendees tab preserving the check-in filter. */
const rosterLanding = (form: FormParams, listingId: number): string => {
  const returnUrl = form.getString("return_url");
  if (returnUrl !== "") return returnUrl;
  const filterValue = form.getString("return_filter");
  const filterQs =
    filterValue === "in" || filterValue === "out"
      ? `?filter=${filterValue}`
      : "";
  return `/admin/listing/${listingId}/attendees${filterQs}`;
};

/** Handle POST /admin/listing/:listingId/attendee/:attendeeId/checkin — both
 * the quantity page's forms and the quantity 1 toggle. The context is the
 * person's whole booking on the listing, so a stale page's count cannot
 * overshoot either direction: admit caps at what the pair owes and release
 * stops at zero. */
export const handleAttendeeCheckin = attendeeBookingFormAction(
  async (data, _session, form, listingId, attendeeId) => {
    // Refuse on a no-quantity ghost row (checked against the exact (attendee,
    // listing) pair) — moveTickets would no-op anyway, but this keeps the
    // message honest.
    const noLineRedirect = await redirectIfNoActiveBookingLine(
      attendeeId,
      listingId,
      form.getString("return_url") || `/admin/listing/${listingId}`,
      "Cannot check in a no-quantity line",
    );
    if (noLineRedirect) return noLineRedirect;

    const target = rosterLanding(form, listingId);
    // The direction is the form's one choice between opposite writes, so
    // only the exact true/false the forms post counts — anything else is a
    // damaged form, not a silent admission.
    const direction = form.getString("check_in");
    if (direction !== "true" && direction !== "false") {
      return redirect(target, "Invalid check-in direction", false, { form });
    }
    // The quantity page names its count. A direct toggle (the quantity 1
    // roster button) posts none and takes the whole booking.
    const rawCount = form.getString("quantity");
    const count =
      rawCount === "" ? data.attendee.quantity : parsePositiveInt(rawCount);
    if (count === null) {
      return redirect(target, "Invalid ticket count", false, { form });
    }

    const moved = ticketCount(
      await moveTickets(direction === "true" ? "admit" : "release", [
        { attendeeId, count, listingId },
      ]),
    );
    // Another request moved every ticket first, so this one changed nothing:
    // no activity row, and a flash that says so.
    if (moved === 0) {
      return redirect(target, "No tickets moved", false);
    }

    const status = direction === "true" ? "in" : "out";
    const tickets = `${moved} ticket${moved === 1 ? "" : "s"}`;
    await logActivity(
      `Attendee checked ${status} ${tickets} for '${data.listing.name}'`,
      listingId,
      attendeeId,
    );
    const flash =
      data.attendee.quantity > 1
        ? `Checked ${data.attendee.name} ${status} (${tickets})`
        : `Checked ${data.attendee.name} ${status}`;
    return redirect(target, flash, true);
  },
);
