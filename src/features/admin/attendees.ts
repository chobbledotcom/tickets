/* jscpd:ignore-start */
import { entityTabRoutes } from "#routes/admin/route-tables.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { adminPattern } from "#shared/admin-surface.ts";
/**
 * Admin attendee management routes
 */

import { logActivity } from "#db/activity-log.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { decryptAttendeeOrNull } from "#db/attendees/pii.ts";
import { getAttendeePackageRowsRaw } from "#db/attendees/queries.ts";
import {
  getListingWithCount,
  requireListingWithCount,
} from "#db/listings/records.ts";
import { hasAnyPaymentReference } from "#db/payment-references.ts";
import { t } from "#i18n";
import { redirect } from "#routes/response.ts";
import { createAuthedFormRoute } from "#shared/app-forms.ts";
import {
  ATTENDEE_DEMO_FIELDS,
  applyDemoOverrides,
} from "#shared/demo/overrides.ts";
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
import {
  handleAttendeeCheckin,
  handleAttendeeCheckinGet,
  redirectIfNoActiveBookingLine,
} from "./attendees-checkin-routes.ts";
import { handleRefreshPayment } from "./attendees-edit.ts";
import {
  handleAttendeesCsvExport,
  handleAttendeesListGet,
} from "./attendees-list.ts";
import { handleMergePost } from "./attendees-merge.ts";
import {
  type AttendeeWithListing,
  attendeeActionPage,
  attendeeActions,
  attendeeFormAction,
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

/** The entries a resend notifies. A standalone line notifies alone; a line
 * belonging to a package rehydrates EVERY line of that attendee's package, so
 * the confirmation doesn't treat a single member row as the whole package
 * (collapsing a hidden package to one row's quantity/price, or heading a
 * visible one with a lone member). */
const resendEntries = async (
  data: AttendeeWithListing,
): Promise<{ attendee: typeof data.attendee; listing: ListingWithCount }[]> => {
  const groupId = data.attendee.package_group_id;
  if (groupId <= 0) return [{ attendee: data.attendee, listing: data.listing }];
  const pk = await requireRequestPrivateKey();
  const rows = await getAttendeePackageRowsRaw(data.attendee.id, groupId);
  return Promise.all(
    // The route already verified this attendee's active line, so its package
    // rows exist, decrypt with the same key, and each names a live listing.
    rows.map(async (row) => ({
      attendee: (await decryptAttendeeOrNull(row, pk))!,
      listing: await requireListingWithCount(row.listing_id),
    })),
  );
};

/** Re-send an attendee's booking notification (its whole package, if any),
 * refusing on a no-quantity ghost row. The verified-action wrapper below runs
 * this after confirming the typed attendee name. */
const resendNotification = async (
  data: AttendeeWithListing,
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

  await Promise.all([
    logAndNotifyRegistration(await resendEntries(data)),
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
  "GET /admin/listing/:listingId/attendee/:attendeeId/checkin":
    handleAttendeeCheckinGet,
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
