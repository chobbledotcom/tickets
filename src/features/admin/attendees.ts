/* jscpd:ignore-start */

import { logActivity } from "#db/activity-log.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import {
  claimOutstandingNotificationFlags,
  restoreClaimedNotificationFlags,
} from "#db/attendees/notification-flags.ts";
import { getAttendeeBookingRowsRaw } from "#db/attendees/queries.ts";
import { storedBookingSource } from "#db/contact-tokens.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { hasAnyPaymentReference } from "#db/payment-references.ts";
import { getAttendeeTextAnswersBatch } from "#db/questions/attendee-answers/reads.ts";
import { t } from "#i18n";
import { emailPendingForAdminLines } from "#routes/admin/attendees-route-helpers.ts";
import { entityTabRoutes } from "#routes/admin/route-tables.ts";
import { redirect } from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import { createAuthedFormRoute } from "#shared/app-forms.ts";
import { createdBookingEntries } from "#shared/booking.ts";
import {
  ATTENDEE_DEMO_FIELDS,
  applyDemoOverrides,
} from "#shared/demo/overrides.ts";
import type { EmailEntry } from "#shared/email.ts";
import type { FormParams } from "#shared/form-data.ts";
import { validateForm } from "#shared/forms/validation.ts";
import { isIncompletePayment } from "#shared/incomplete-payment.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import {
  logAndNotifyRegistration,
  queueManualAddWebhooks,
} from "#shared/webhook/delivery.ts";
import { adminResendNotificationPage } from "#templates/admin/attendees.tsx";
import {
  type AddAttendeeFormValues,
  getAddAttendeeFields,
} from "#templates/fields/add-attendee.ts";
import {
  availableDayCounts,
  isPaidListing,
  type ListingFields,
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
  type AttendeeWithBooking,
  attendeeActionPage,
  attendeeActions,
  attendeeFormAction,
  attendeeListingEntries,
} from "./attendees-route-helpers.ts";

/* jscpd:ignore-end */

/**
 * Deletes an attendee with an incomplete payment. The name confirmation does
 * not apply here.
 */
const handleDeleteIncomplete = attendeeFormAction(
  async (data, _session, _form, listingId, attendeeId) => {
    // The failed-payments delete form lives on the Attendees tab, so both
    // outcomes return there. The operator stays on the table they are
    // clearing instead of bouncing to Overview.
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

const buildCreateAttendeeInput = (
  values: AddAttendeeFormValues,
  listing: {
    id: number;
    listing_type: string;
    customisable_days: boolean;
    duration_days: number;
    fields: ListingFields;
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
    // The confirmation email is owed the moment the attendee exists. The
    // admin add never sends it itself, so the flag stays up until the
    // Re-send notification action gets an accepted send. Webhooks are never
    // owed for a hand-added attendee.
    emailPending: emailPendingForAdminLines([
      { fields: listing.fields, isBooked: quantity > 0 },
    ]),
    name,
    phone: phone || "",
    source: "admin" as const,
    special_instructions: special_instructions || "",
  };
};

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
      // Same behavior as the admin form's manual add: the new booking tells
      // the listing's webhooks. The buyer email waits for the "Re-send
      // notification" action, which sends the webhooks again too. The
      // activity line above stays the only create line. A quantity-0 ghost
      // line books nothing, so createdBookingEntries skips it, as the
      // attendee actions refuse a no-quantity row.
      queueManualAddWebhooks(
        createdBookingEntries(
          createResult.attendees,
          new Map([[listing.id, listing]]),
        ),
      );
      // Land on the roster (Attendees tab), where the new attendee and the
      // quick-add form live. The flash and the added row are then both in
      // view.
      return redirect(
        `/admin/listing/${params.listingId}/attendees`,
        t("attendee_form.saved_added", { value: values.name }),
        true,
      );
    },
    preprocessForm: (form) => applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS),
  });

const handleAdminResendNotificationGet = attendeeActions[
  "resend-notification"
].page(attendeeActionPage(adminResendNotificationPage));

/** Every booking line the attendee holds, rebuilt as notification entries.
 * Each entry comes from its own row and listing. A confirmation never treats
 * one member row as the whole purchase. One member row alone reads wrong in
 * three ways. It collapses a hidden package to one row's quantity and price.
 * It heads a visible one with a lone member. It hides the plan line that
 * bought a site. Refunded rows stay in. The email filters them out below.
 * The assignment's served check needs them to see a claim recorded before
 * the refund. */
const bookingEntries = async (attendeeId: number): Promise<EmailEntry[]> => {
  const pk = await requireRequestPrivateKey();
  const rows = await getAttendeeBookingRowsRaw(attendeeId);
  // The route already verified this attendee's active line, so its booking
  // rows exist, decrypt with the same key, and each names a live listing.
  return attendeeListingEntries(rows, pk);
};

/** Re-send the attendee's notification for EVERY booking they hold: every
 * package and every standalone line, one send carrying all of them. A
 * partial resend beside another purchase never delivers that purchase's
 * tickets and never clears its flags. Refuses on a no-quantity ghost row.
 * The verified-action wrapper below runs this after confirming the typed
 * attendee name. */
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
    t("attendees.resend_refused_no_line"),
    { form },
  );
  if (noLineRedirect) return noLineRedirect;

  // Every line the attendee holds, refunded ones included: the site
  // assignment reads them all, because one site serves the whole buyer. A
  // claim recorded on another purchase's plan keeps the buyer served. So
  // does a claim on a line refunded later.
  const entries = await bookingEntries(attendeeId);

  // The webhook reports how the booking was made. It reads the stored
  // booking, not who pressed the button. A booking with no contact history
  // has no stored source, so the payload says "unknown".
  const source =
    (await storedBookingSource(
      data.attendee.email,
      data.attendee.phone,
      data.attendee.ticket_token,
      await requireRequestPrivateKey(),
    )) ?? "unknown";

  // A refunded line bought nothing now, so the resend must not notify it
  // again.
  const notify = entries.filter((entry) => !entry.attendee.refunded);
  if (notify.length === 0) {
    return redirect(actionsTab, t("attendees.resend_refused_refunded"), false, {
      form,
    });
  }

  // An admin session can spend the owner key. The resend is therefore the
  // one path that reads the buyer's free-text answers straight from the
  // strings table.
  const freeTexts = (
    await getAttendeeTextAnswersBatch(
      [attendeeId],
      await requireRequestPrivateKey(),
    )
  ).get(attendeeId);

  // The flags are the record of what never went out, so a recovery re-sends
  // only the sides they say are owed. The claim flips those flags down in
  // one atomic batch. That batch also admits exactly one recovery per
  // attendee: a second concurrent press finds nothing outstanding and is
  // refused.
  const recoveredSides = await claimOutstandingNotificationFlags(attendeeId);
  if (recoveredSides.length === 0) {
    return redirect(
      actionsTab,
      t("attendees.resend_refused_nothing_owed"),
      false,
      { form },
    );
  }

  try {
    await Promise.all([
      logAndNotifyRegistration(notify, {
        // This resend carries every live booking line the attendee holds, so
        // its sends own the attendee's pending-notification flags. The email
        // send clears email_pending when its far side accepts. The webhook
        // send clears webhooks_pending the same way. A refused send leaves
        // its flag up, so the badge keeps saying what never went out.
        clearPendingFlagsFor: [attendeeId],
        freeTexts,
        recoverSides: recoveredSides,
        // One site serves the whole buyer, so the assignment reads every
        // line they hold, refunded ones too. A claim recorded on another
        // purchase's plan keeps the buyer served. So does a claim on a line
        // refunded later.
        siteAssignmentEntries: entries,
        source,
      }),
      logActivity(
        `Notification re-sent for attendee '${data.attendee.name}'`,
        data.listing.id,
        attendeeId,
      ),
    ]);
  } catch (error) {
    // The claim is a lease for sends that never ran. Release it, so the
    // flags keep saying what is still owed and the recovery stays
    // retryable.
    await restoreClaimedNotificationFlags(attendeeId, recoveredSides);
    throw error;
  }
  return redirect(actionsTab, t("success.notification_resent"), true, {
    form,
  });
};

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
