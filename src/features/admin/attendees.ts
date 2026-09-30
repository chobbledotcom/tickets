/* jscpd:ignore-start */
import { entityTabRoutes } from "#routes/admin/route-tables.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { adminPattern } from "#shared/admin-surface.ts";
/**
 * Admin attendee management routes
 */

import { logActivity } from "#db/activity-log.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import {
  getAttendeeBookingRowsRaw,
  hasActiveBookingLine,
} from "#db/attendees/queries.ts";
import { updateCheckedIn } from "#db/attendees/update.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { hasAnyPaymentReference } from "#db/payment-references.ts";
import { getAttendeeTextAnswersBatch } from "#db/questions/attendee-answers/reads.ts";
import { t } from "#i18n";
import { redirect } from "#routes/response.ts";
import { createAuthedFormRoute } from "#shared/app-forms.ts";
import {
  ATTENDEE_DEMO_FIELDS,
  applyDemoOverrides,
} from "#shared/demo/overrides.ts";
import type { EmailEntry } from "#shared/email.ts";
import type { FormParams } from "#shared/form-data.ts";
import { validateForm } from "#shared/forms/validation.ts";
import { isIncompletePayment } from "#shared/incomplete-payment.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { logAndNotifyRegistration } from "#shared/webhook/delivery.ts";
import { adminResendNotificationPage } from "#templates/admin/attendees.tsx";
import {
  type AddAttendeeFormValues,
  getAddAttendeeFields,
} from "#templates/fields/add-attendee.ts";
import {
  availableDayCounts,
  isPaidListing,
  type ListingWithCount,
} from "#types";
import {
  deleteAttendeeAndRedirect,
  handleAdminAttendeeDeleteGet,
  handleAttendeeDelete,
} from "./attendee-delete.ts";
import {
  handleAttendeeEditPost,
  handleAttendeeNewGet,
  handleAttendeeNewPost,
} from "./attendee-form-routes.ts";
import { handleAttendeeLogisticsPost } from "./attendee-logistics-routes.ts";
import { attendeePage } from "./attendee-page.ts";
import { paymentReviewHandlers } from "./attendee-payment-review.ts";
import { handleRefreshPayment } from "./attendees-edit.ts";
import {
  handleAttendeesCsvExport,
  handleAttendeesListGet,
} from "./attendees-list.ts";
import { handleMergePost } from "./attendees-merge.ts";
import {
  type AttendeeWithBooking,
  attendeeActionPage,
  attendeeActions,
  attendeeFormAction,
  attendeeListingEntries,
} from "./attendees-route-helpers.ts";

/* jscpd:ignore-end */

/**
 * Handle POST /admin/listing/:listingId/attendee/:attendeeId/delete-incomplete
 * Deletes an attendee with an incomplete payment without requiring name confirmation.
 * Verifies the attendee is actually incomplete before deleting.
 */
const handleDeleteIncomplete = attendeeFormAction(
  async (data, _session, _form, listingId, attendeeId) => {
    // The failed-payments delete form lives on the Attendees tab, so both
    // outcomes return there — keeping the operator on the table they are
    // clearing rather than bouncing them to Overview.
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

    // The roster's check-in form threads its filtered-view URL through
    // return_url; when absent (e.g. the scanner) fall back to the Attendees tab,
    // preserving any check-in filter. Either way the confirmation shows as a
    // flash on the landing tab — the old ?checkin_name= surface is gone.
    const returnUrl = form.getString("return_url");
    const filterValue = form.getString("return_filter");
    const filterQs =
      filterValue === "in" || filterValue === "out"
        ? `?filter=${filterValue}`
        : "";
    const target =
      returnUrl || `/admin/listing/${listingId}/attendees${filterQs}`;
    return redirect(target, `Checked ${data.attendee.name} ${status}`, true);
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
  // Customisable daily bookings span the admin's chosen day count. The shared
  // boundary clamps whole numbers outside its range and rejects malformed
  // numbers. Other daily bookings use the fixed duration.
  const durationDays = listing.customisable_days
    ? Number(values.day_count)
    : listing.duration_days;
  return {
    address: address || "",
    bookings: [
      {
        date: isDaily ? date : null,
        ...(isDaily ? { durationDays } : {}),
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
      redirect(`/admin/listing/${params.listingId}/attendees`, error, false),
    onValid: async ({ context: listing, params, values }) => {
      const createResult = await attendeesApi.createAttendeeAtomic(
        buildCreateAttendeeInput(values, listing),
      );
      if (!createResult.success) {
        // Back to the roster, where the quick-add form is, so the operator can
        // correct the quantity in context.
        return redirect(
          `/admin/listing/${params.listingId}/attendees`,
          t("error.not_enough_spots"),
          false,
        );
      }
      await logActivity(
        `Attendee '${values.name}' added manually`,
        params.listingId,
        createResult.attendees[0]!.id,
      );
      // Land on the roster (Attendees tab), where the new attendee and the
      // quick-add form live, so the flash and the added row are both in view.
      return redirect(
        `/admin/listing/${params.listingId}/attendees`,
        `Added ${values.name}`,
        true,
      );
    },
    preprocessForm: (form) => applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS),
  });

/** Handle GET /admin/attendees/:attendeeId/resend-notification */
const handleAdminResendNotificationGet = attendeeActions[
  "resend-notification"
].page(attendeeActionPage(adminResendNotificationPage));

/** The entries a resend covers, scoped to the SELECTED booking's purchase:
 * a package line rehydrates its own package alone (never another package the
 * attendee holds), and a standalone line covers every standalone line the
 * attendee booked. Each entry is rebuilt from its own row and listing, so the
 * confirmation never treats one member row as the whole purchase — collapsing
 * a hidden package to one row's quantity/price, heading a visible one with a
 * lone member, or hiding the plan line that bought a site. Refunded rows
 * stay in the list: the email filters them out below, while the assignment's
 * served check needs them to see a claim recorded before the refund. */
const purchaseEntries = async (
  data: AttendeeWithBooking,
): Promise<EmailEntry[]> => {
  const pk = await requireRequestPrivateKey();
  const rows = await getAttendeeBookingRowsRaw(
    data.attendee.id,
    data.selectedPackageGroupId > 0
      ? { kind: "package", packageGroupId: data.selectedPackageGroupId }
      : { kind: "standalone" },
  );
  // The route already verified this attendee's active line, so its booking
  // rows exist, decrypt with the same key, and each names a live listing.
  return attendeeListingEntries(rows, pk);
};

/** Re-send an attendee's booking notification (its whole package, if any),
 * refusing on a no-quantity ghost row. The verified-action wrapper below runs
 * this after confirming the typed attendee name. */
const resendNotification = async (
  data: AttendeeWithBooking,
  form: FormParams,
): Promise<Response> => {
  const attendeeId = data.attendee.id;
  const actionsTab = `/admin/attendees/${attendeeId}/actions`;
  // Refuse on a no-quantity ghost row: the customer email/webhook is built
  // from the home listing, so it must not fire for a non-booking.
  const noLineRedirect = await redirectIfNoActiveBookingLine(
    attendeeId,
    data.listing.id,
    actionsTab,
    "Cannot re-send a notification for a no-quantity line",
    { form },
  );
  if (noLineRedirect) return noLineRedirect;

  // An admin session can spend the owner key, so the resend is the one path
  // that reads the buyer's free-text answers straight from the strings table.
  const freeTexts = (
    await getAttendeeTextAnswersBatch(
      [attendeeId],
      await requireRequestPrivateKey(),
    )
  ).get(attendeeId);

  // A refunded line bought nothing now, so the resend must not notify it
  // again. The assignment still sees it, so a claim recorded on it before the
  // refund keeps the buyer served.
  const entries = await purchaseEntries(data);
  const notify = entries.filter((entry) => !entry.attendee.refunded);
  await Promise.all([
    logAndNotifyRegistration(notify, {
      freeTexts,
      siteAssignmentEntries: entries,
    }),
    logActivity(
      `Notification re-sent for attendee '${data.attendee.name}'`,
      data.listing.id,
      attendeeId,
    ),
  ]);
  return redirect(actionsTab, t("success.notification_resent"), true, {
    form,
  });
};

/** Handle POST /admin/attendees/:attendeeId/resend-notification */
const handleResendNotification = attendeeActions[
  "resend-notification"
].verified(undefined, resendNotification);

/**
 * Attendee routes
 * Unified add/edit page (add/update/remove listing registrations):
 *   attendee-form-routes.ts
 * Paginated attendees browser: attendees-list.ts
 * Refresh payment: attendees-edit.ts
 * Merge: attendees-merge.ts
 * Payment review: attendee-payment-review.ts
 * Refunds: attendee-refunds.ts
 */
export const adminHandlers = defineRoutes({
  ...entityTabRoutes(adminPattern("attendee"), attendeePage),
  ...paymentReviewHandlers,
  "DELETE /admin/attendees/:attendeeId/delete": handleAttendeeDelete,
  "GET /admin/attendees": handleAttendeesListGet,
  "GET /admin/attendees/:attendeeId/delete": handleAdminAttendeeDeleteGet,
  "GET /admin/attendees/:attendeeId/resend-notification":
    handleAdminResendNotificationGet,
  "GET /admin/attendees/csv": handleAttendeesCsvExport,
  "GET /admin/attendees/new": handleAttendeeNewGet,
  "POST /admin/attendees/:attendeeId": handleAttendeeEditPost,
  "POST /admin/attendees/:attendeeId/delete": handleAttendeeDelete,
  "POST /admin/attendees/:attendeeId/logistics": handleAttendeeLogisticsPost,
  "POST /admin/attendees/:attendeeId/merge": handleMergePost,
  "POST /admin/attendees/:attendeeId/refresh-payment": handleRefreshPayment,
  "POST /admin/attendees/:attendeeId/resend-notification":
    handleResendNotification,
  "POST /admin/attendees/new": handleAttendeeNewPost,
  "POST /admin/listing/:listingId/attendee": handleAddAttendee,
  "POST /admin/listing/:listingId/attendee/:attendeeId/checkin":
    handleAttendeeCheckin,
  "POST /admin/listing/:listingId/attendee/:attendeeId/delete-incomplete":
    handleDeleteIncomplete,
});
