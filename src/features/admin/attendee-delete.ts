import { t } from "#i18n";
import { loadAttendeeActionState } from "#routes/admin/attendee-action-state.ts";
import {
  type AttendeeRecord,
  attendeeFormAction,
  attendeeRecordActionPage,
  verifiedAttendeeRecordAction,
} from "#routes/admin/attendees-route-helpers.ts";
import { redirect } from "#routes/response.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { deleteAttendee } from "#shared/db/attendees/delete.ts";
import { hasAnyPaymentReference } from "#shared/db/payment-references.ts";
import { isIncompletePayment } from "#shared/incomplete-payment.ts";
import { isPaidListing } from "#shared/types.ts";
import { adminDeleteAttendeePage } from "#templates/admin/attendees.tsx";

/** The delete confirm page is available only while its POST can succeed. */
export const handleAdminAttendeeDeleteGet = attendeeRecordActionPage(
  adminDeleteAttendeePage,
  async ({ attendee }) =>
    (await loadAttendeeActionState(attendee.id)).canDelete,
);

/** Delete an attendee, log the activity, and redirect. */
const deleteAttendeeAndRedirect = async (
  attendeeId: number,
  listingId: number | null,
  redirectTo: string,
  activityMessage: string,
  flashMessage: string,
  opts?: Parameters<typeof redirect>[3],
  releaseBookings = true,
): Promise<Response> => {
  const actionState = await loadAttendeeActionState(attendeeId);
  // A pending staged checkout claims the exact rows when the payment lands, so
  // deleting the record mid-payment would strand the paid order.
  if (actionState.pendingCheckout) {
    return redirect(
      redirectTo,
      t("attendee_form.error_pending_checkout"),
      false,
      opts,
    );
  }
  // Held provider cash needs the attendee's refund path. Deleting first would
  // leave orphaned ledger cash that the operator could no longer return.
  if (actionState.holdsUnreturnedCash) {
    return redirect(
      redirectTo,
      t("attendee_form.error_held_cash"),
      false,
      opts,
    );
  }
  await deleteAttendee(attendeeId, { releaseBookings });
  await logActivity(activityMessage, listingId, attendeeId);
  return redirect(redirectTo, flashMessage, true, opts);
};

/** Delete a retained record. Its home listing may already be gone. */
export const handleAttendeeDelete = verifiedAttendeeRecordAction(
  "delete",
  "deletion",
  (data: AttendeeRecord, form) =>
    deleteAttendeeAndRedirect(
      data.attendee.id,
      data.listing?.id ?? null,
      "/admin/attendees",
      data.listing
        ? `Attendee deleted from '${data.listing.name}'`
        : `Attendee '${data.attendee.name}' deleted`,
      t("success.attendee_deleted"),
      { form },
      form.getFlag("release_bookings"),
    ),
);

/** Delete a genuinely incomplete payment from a live listing roster. */
export const handleDeleteIncomplete = attendeeFormAction(
  async (data, _session, _form, listingId, attendeeId) => {
    if (
      !isIncompletePayment(
        data.attendee,
        isPaidListing(data.listing),
        await hasAnyPaymentReference(data.attendee),
      )
    ) {
      return redirect(
        `/admin/listing/${listingId}/attendees`,
        t("error.attendee_no_incomplete_payment"),
        false,
      );
    }

    return deleteAttendeeAndRedirect(
      attendeeId,
      listingId,
      `/admin/listing/${listingId}/attendees`,
      `Incomplete attendee deleted from '${data.listing.name}'`,
      t("success.incomplete_removed"),
    );
  },
);
