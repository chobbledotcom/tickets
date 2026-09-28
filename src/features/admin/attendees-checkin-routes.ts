/** The roster's check-in routes: the quantity page a multi-ticket line's
 * Check In / Check Out link opens, and the POST both that page and the
 * quantity 1 toggle submit. One module so the listing-scoped attendee routes
 * file stays under its line budget. */

import { logActivity } from "#db/activity-log.ts";
import { hasActiveBookingLine } from "#db/attendees/queries.ts";
import { moveTickets } from "#db/attendees/update.ts";
import { requireSessionOr } from "#routes/auth.ts";
import { htmlResponse, redirect } from "#routes/response.ts";
import { getSearchParam } from "#routes/url.ts";
import type { FormParams } from "#shared/form-data.ts";
import { attendeeCheckinQuantityPage } from "#templates/admin/attendees/checkin-quantity.tsx";
import {
  attendeeFormAction,
  getReturnUrl,
  withAttendee,
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
    withAttendee(
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

/** Handle POST /admin/listing/:listingId/attendee/:attendeeId/checkin */
export const handleAttendeeCheckin = attendeeFormAction(
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

    // The quantity page names its count. A direct toggle (the quantity 1
    // roster button) posts none and takes the whole line.
    const checkIn = form.getString("check_in") !== "false";
    const rawCount = form.getString("quantity");
    const count =
      rawCount === "" ? data.attendee.quantity : Number.parseInt(rawCount, 10);
    const target = rosterLanding(form, listingId);

    if (!Number.isInteger(count) || count < 1) {
      return redirect(target, "Invalid ticket count", false, { form });
    }

    // admit caps at the line's quantity and release stops at zero, so a
    // stale page's count cannot overshoot either direction.
    await moveTickets(
      checkIn ? "admit" : "release",
      attendeeId,
      listingId,
      count,
    );

    const status = checkIn ? "in" : "out";
    const tickets = `${count} ticket${count === 1 ? "" : "s"}`;
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
