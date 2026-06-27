/**
 * Admin attendee management routes
 */

import { t } from "#i18n";
import { handleAttendeeBalanceGet } from "#routes/admin/attendee-balance.ts";
import { applyFlash } from "#routes/csrf.ts";
import { htmlResponse, redirect, redirectResponse } from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { createAuthedFormRoute } from "#shared/app-forms.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import {
  createAttendeeAtomic,
  deleteAttendee,
  hasActiveBookingLine,
  updateCheckedIn,
} from "#shared/db/attendees.ts";
import { getListingWithCount } from "#shared/db/listings.ts";
import { ATTENDEE_DEMO_FIELDS, applyDemoOverrides } from "#shared/demo.ts";
import { validateForm } from "#shared/forms.tsx";
import { ErrorCode, logError } from "#shared/logger.ts";
import {
  type AdminSession,
  availableDayCounts,
  isPaidListing,
  type ListingWithCount,
} from "#shared/types.ts";
import { logAndNotifyRegistration } from "#shared/webhook.ts";
import {
  adminDeleteAttendeePage,
  adminResendNotificationPage,
} from "#templates/admin/attendees.tsx";
import {
  type AddAttendeeFormValues,
  getAddAttendeeFields,
} from "#templates/fields.ts";
import {
  handleAttendeeEditGet,
  handleAttendeeEditPost,
  handleAttendeeNewGet,
  handleAttendeeNewPost,
} from "./attendee-form-routes.ts";
import { handleRefreshPayment } from "./attendees-edit.ts";
import {
  handleAttendeesCsvExport,
  handleAttendeesListGet,
} from "./attendees-list.ts";
import { handleMergeGet, handleMergePost } from "./attendees-merge.ts";
import {
  type AttendeeWithListing,
  attendeeFormAction,
  attendeeGetRoute,
  getReturnUrl,
  verifiedAttendeeForm,
} from "./attendees-route-helpers.ts";

/** Signature shared by all attendee GET page renderers */
type AttendeePageRenderer = (
  data: AttendeeWithListing,
  session: AdminSession,
  returnUrl?: string,
  error?: string,
) => string;

/** Create a GET handler that renders an attendee page with flash error */
const attendeePageRoute = (render: AttendeePageRenderer) =>
  attendeeGetRoute((data, session, request) => {
    const flash = applyFlash(request);
    return htmlResponse(
      render(data, session, getReturnUrl(request), flash.error),
    );
  });

/** Handle GET /admin/listing/:listingId/attendee/:attendeeId/delete */
const handleAdminAttendeeDeleteGet = attendeePageRoute(adminDeleteAttendeePage);

/** Delete an attendee, log the activity, and redirect back to the listing. */
const deleteAttendeeAndRedirect = async (
  attendeeId: number,
  listingId: number,
  activityMessage: string,
  flashMessage: string,
  opts?: Parameters<typeof redirect>[3],
  releaseBookings = true,
): Promise<Response> => {
  await deleteAttendee(attendeeId, { releaseBookings });
  await logActivity(activityMessage, listingId, attendeeId);
  return redirect(`/admin/listing/${listingId}`, flashMessage, true, opts);
};

/** Handle POST /admin/listing/:listingId/attendee/:attendeeId/delete */
const handleAttendeeDelete = verifiedAttendeeForm(
  "delete",
  "deletion",
  (data, form, listingId, attendeeId) =>
    deleteAttendeeAndRedirect(
      attendeeId,
      listingId,
      `Attendee deleted from '${data.listing.name}'`,
      t("success.attendee_deleted"),
      { form },
      form.get("release_bookings") === "1",
    ),
);

/**
 * Handle POST /admin/listing/:listingId/attendee/:attendeeId/delete-incomplete
 * Deletes an attendee with an incomplete payment without requiring name confirmation.
 * Verifies the attendee is actually incomplete before deleting.
 */
const handleDeleteIncomplete = attendeeFormAction(
  async (data, _session, _form, listingId, attendeeId) => {
    const hasPaidListing = isPaidListing(data.listing);
    // An "incomplete" registration is an abandoned paid checkout: a sale was
    // recognised (price_paid > 0) and fully covered (nothing still owed), yet no
    // payment id was ever linked. A provider-less booking owes its full value
    // (remaining_balance > 0) even though price_paid now projects the gross sale
    // leg, so it is a real registration — not an abandoned checkout — and must
    // not be swept here. A free booking (price_paid 0) likewise isn't incomplete.
    const isIncomplete =
      hasPaidListing &&
      !data.attendee.payment_id &&
      Number.parseInt(data.attendee.price_paid, 10) > 0 &&
      data.attendee.remaining_balance <= 0;

    if (!isIncomplete) {
      return redirect(
        `/admin/listing/${listingId}`,
        t("error.attendee_no_incomplete_payment"),
        false,
      );
    }

    return deleteAttendeeAndRedirect(
      attendeeId,
      listingId,
      `Incomplete attendee deleted from '${data.listing.name}'`,
      t("success.incomplete_removed"),
    );
  },
);

/** Return a redirect response when the attendee has no active booking line, or null otherwise. */
const redirectIfNoActiveBookingLine = async (
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

/** Handle POST /admin/listing/:listingId/attendee/:attendeeId/checkin */
const handleAttendeeCheckin = attendeeFormAction(
  async (data, _session, form, listingId, attendeeId) => {
    // Refuse on a no-quantity ghost row (checked against the exact (attendee,
    // listing) pair, since data.attendee is an arbitrary left-joined sibling) —
    // updateCheckedIn would no-op anyway, but this keeps the message honest.
    const noLineRedirect = await redirectIfNoActiveBookingLine(
      attendeeId,
      listingId,
      form.getString("return_url") || `/admin/listing/${listingId}`,
      "Cannot check in a no-quantity line",
    );
    if (noLineRedirect) return noLineRedirect;

    const wasCheckedIn = data.attendee.checked_in;
    const nowCheckedIn = !wasCheckedIn;

    await updateCheckedIn(attendeeId, listingId, nowCheckedIn);

    const status = nowCheckedIn ? "in" : "out";
    await logActivity(
      `Attendee checked ${status} for '${data.listing.name}'`,
      listingId,
      attendeeId,
    );

    const returnUrl = form.getString("return_url");
    if (returnUrl) {
      return redirect(
        returnUrl,
        `Checked ${data.attendee.name} ${status}`,
        true,
      );
    }

    const name = encodeURIComponent(data.attendee.name);
    const filterValue = form.getString("return_filter");
    const suffix =
      filterValue === "in" ? "/in" : filterValue === "out" ? "/out" : "";
    return redirectResponse(
      `/admin/listing/${listingId}${suffix}?checkin_name=${name}&checkin_status=${status}#message`,
    );
  },
);

/** Build create-attendee input from validated form values */
const buildCreateAttendeeInput = (
  values: AddAttendeeFormValues,
  listing: {
    id: number;
    listing_type: string;
    customisable_days: boolean;
    duration_days: number;
  },
) => {
  const { name, email, phone, address, special_instructions, quantity, date } =
    values;
  const isDaily = listing.listing_type === "daily";
  // Customisable daily bookings span the admin's chosen day count (a required,
  // options-constrained field; any odd value is clamped downstream by
  // normalizeDurationDays); other daily bookings use the fixed duration.
  const durationDays = listing.customisable_days
    ? Number(values.day_count)
    : listing.duration_days;
  return {
    address: address || "",
    bookings: [
      {
        date: isDaily ? date : null,
        durationDays: isDaily ? durationDays : undefined,
        listingId: listing.id,
        quantity,
      },
    ],
    email: email || "",
    name,
    phone: phone || "",
    source: "admin" as const,
    special_instructions: special_instructions || "",
  };
};

/** Convert a failed createAttendeeAtomic result into a redirect response */
const handleCreateAttendeeFailure = (
  result: { success: false; reason: string },
  listingId: number,
): Response => {
  if (result.reason === "encryption_error") {
    logError({
      code: ErrorCode.ENCRYPT_FAILED,
      detail: "manual add attendee",
      listingId,
    });
  }
  const errorMsg =
    result.reason === "capacity_exceeded"
      ? t("error.not_enough_spots")
      : t("error.encryption_error");
  return redirect(`/admin/listing/${listingId}`, errorMsg, false);
};

/** Handle POST /admin/listing/:listingId/attendee (add attendee manually) */
const handleAddAttendee: TypedRouteHandler<"POST /admin/listing/:listingId/attendee"> =
  createAuthedFormRoute<
    AddAttendeeFormValues,
    { listingId: number },
    ListingWithCount
  >({
    form: (listing) => ({
      validate: (form) =>
        validateForm<AddAttendeeFormValues>(
          form,
          getAddAttendeeFields(
            listing.fields,
            listing.listing_type === "daily",
            listing.customisable_days && listing.listing_type === "daily"
              ? availableDayCounts(listing)
              : undefined,
          ),
        ),
    }),
    loadContext: ({ listingId }) => getListingWithCount(listingId),
    onInvalid: ({ error, params }) =>
      redirect(`/admin/listing/${params.listingId}`, error, false),
    onValid: async ({ context: listing, params, values }) => {
      const createResult = await createAttendeeAtomic(
        buildCreateAttendeeInput(values, listing),
      );
      if (!createResult.success) {
        return handleCreateAttendeeFailure(createResult, params.listingId);
      }
      await logActivity(
        `Attendee '${values.name}' added manually`,
        params.listingId,
        createResult.attendees[0]!.id,
      );
      return redirect(
        `/admin/listing/${params.listingId}`,
        `Added ${values.name}`,
        true,
      );
    },
    preprocessForm: (form) => applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS),
  });

/** Handle GET /admin/listing/:listingId/attendee/:attendeeId/resend-notification */
const handleAdminResendNotificationGet = attendeePageRoute(
  adminResendNotificationPage,
);

/** Handle POST /admin/listing/:listingId/attendee/:attendeeId/resend-notification */
const handleResendNotification = verifiedAttendeeForm(
  "resend-notification",
  undefined,
  async (data, form, listingId, attendeeId) => {
    // Refuse on a no-quantity ghost row: this listing-scoped route builds the
    // customer email/webhook from the supplied listing, so it must not fire for
    // a non-booking (nor retarget to a real line on another listing).
    const noLineRedirect = await redirectIfNoActiveBookingLine(
      attendeeId,
      listingId,
      `/admin/listing/${listingId}`,
      "Cannot re-send a notification for a no-quantity line",
      { form },
    );
    if (noLineRedirect) return noLineRedirect;

    await Promise.all([
      logAndNotifyRegistration([
        { attendee: data.attendee, listing: data.listing },
      ]),
      logActivity(
        `Notification re-sent for attendee '${data.attendee.name}'`,
        listingId,
        data.attendee.id,
      ),
    ]);
    return redirect(
      `/admin/listing/${listingId}`,
      t("success.notification_resent"),
      true,
      {
        form,
      },
    );
  },
);

/**
 * Attendee routes
 * Unified add/edit page (add/update/remove listing registrations):
 *   attendee-form-routes.ts
 * Paginated attendees browser: attendees-list.ts
 * Refresh payment: attendees-edit.ts
 * Merge: attendees-merge.ts
 * Refunds: attendee-refunds.ts
 */
export const attendeesRoutes = defineRoutes({
  "DELETE /admin/listing/:listingId/attendee/:attendeeId/delete":
    handleAttendeeDelete,
  "GET /admin/attendees": handleAttendeesListGet,
  "GET /admin/attendees/:attendeeId": handleAttendeeEditGet,
  "GET /admin/attendees/:attendeeId/balance": handleAttendeeBalanceGet,
  "GET /admin/attendees/:attendeeId/merge": handleMergeGet,
  "GET /admin/attendees/csv": handleAttendeesCsvExport,
  "GET /admin/attendees/new": handleAttendeeNewGet,
  "GET /admin/listing/:listingId/attendee/:attendeeId/delete":
    handleAdminAttendeeDeleteGet,
  "GET /admin/listing/:listingId/attendee/:attendeeId/resend-notification":
    handleAdminResendNotificationGet,
  "POST /admin/attendees/:attendeeId": handleAttendeeEditPost,
  "POST /admin/attendees/:attendeeId/merge": handleMergePost,
  "POST /admin/attendees/:attendeeId/refresh-payment": handleRefreshPayment,
  "POST /admin/attendees/new": handleAttendeeNewPost,
  "POST /admin/listing/:listingId/attendee": handleAddAttendee,
  "POST /admin/listing/:listingId/attendee/:attendeeId/checkin":
    handleAttendeeCheckin,
  "POST /admin/listing/:listingId/attendee/:attendeeId/delete":
    handleAttendeeDelete,
  "POST /admin/listing/:listingId/attendee/:attendeeId/delete-incomplete":
    handleDeleteIncomplete,
  "POST /admin/listing/:listingId/attendee/:attendeeId/resend-notification":
    handleResendNotification,
});
