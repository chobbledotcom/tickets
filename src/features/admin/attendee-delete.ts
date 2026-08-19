/** Attendee deletion routes and their payment-lifecycle admission. */

import { logActivity } from "#db/activity-log.ts";
import { deleteAttendee } from "#db/attendees/delete.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { loadPaymentMoveSnapshot, orRefusal } from "#db/payment-admit-move.ts";
import { t } from "#i18n";
import { redirect } from "#routes/response.ts";
import {
  adminAttendeeDeletePage,
  adminBlockedAttendeeDeletePage,
} from "#templates/admin/attendees/delete-confirm.tsx";
import { attendeeActions } from "./attendees-route-helpers.ts";

/** The delete URL renders no destructive form while payment work blocks it. */
export const handleAdminAttendeeDeleteGet = attendeeActions.delete.page(
  async ({ attendee }) => {
    const admission = (await loadPaymentMoveSnapshot([attendee.id])).admission
      .delete;
    return admission.kind === "available"
      ? { reason: null, render: adminAttendeeDeletePage }
      : { reason: admission.reason, render: adminBlockedAttendeeDeletePage };
  },
);

/** Delete one attendee and turn a payment-work refusal into an operator reply. */
export const deleteAttendeeAndRedirect = (
  attendeeId: number,
  listingId: number | null,
  redirectTo: string,
  activityMessage: string,
  flashMessage: string,
  opts?: Parameters<typeof redirect>[3],
  releaseBookings = true,
): Promise<Response> =>
  orRefusal(
    async () => {
      await deleteAttendee(attendeeId, { releaseBookings });
      await logActivity(activityMessage, listingId, attendeeId);
      return redirect(redirectTo, flashMessage, true, opts);
    },
    (message) => redirect(redirectTo, message, false, opts),
  );

/** Delete the attendee after confirmation; the writer rechecks payment work. */
export const handleAttendeeDelete = attendeeActions.delete.verified(
  "deletion",
  async ({ attendee }, form) => {
    const listing = await getListingWithCount(attendee.listing_id);
    return deleteAttendeeAndRedirect(
      attendee.id,
      listing?.id ?? null,
      "/admin/attendees",
      listing
        ? `Attendee deleted from '${listing.name}'`
        : `Attendee '${attendee.name}' deleted`,
      t("success.attendee_deleted"),
      { form },
      form.getFlag("release_bookings"),
    );
  },
);
