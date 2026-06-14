/**
 * Admin attendee management routes
 */

import { applyFlash } from "#routes/csrf.ts";
import { htmlResponse, redirect, redirectResponse } from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { createAuthedFormRoute } from "#shared/app-forms.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import {
  createAttendeeAtomic,
  deleteAttendee,
  updateCheckedIn,
} from "#shared/db/attendees.ts";
import { getEventWithCount } from "#shared/db/events.ts";
import { ATTENDEE_DEMO_FIELDS, applyDemoOverrides } from "#shared/demo.ts";
import { validateForm } from "#shared/forms.tsx";
import { ErrorCode, logError } from "#shared/logger.ts";
import {
  type AdminSession,
  type EventWithCount,
  isPaidEvent,
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
  handleAddEventLink,
  handleUnlinkEvent,
  handleUpdateEventLink,
} from "./attendees-links.ts";
import { handleMergeGet, handleMergePost } from "./attendees-merge.ts";
import {
  type AttendeeWithEvent,
  attendeeFormAction,
  attendeeGetRoute,
  getReturnUrl,
  verifiedAttendeeForm,
} from "./attendees-route-helpers.ts";

/** Signature shared by all attendee GET page renderers */
type AttendeePageRenderer = (
  data: AttendeeWithEvent,
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

/** Handle GET /admin/event/:eventId/attendee/:attendeeId/delete */
const handleAdminAttendeeDeleteGet = attendeePageRoute(adminDeleteAttendeePage);

/** Handle POST /admin/event/:eventId/attendee/:attendeeId/delete */
const handleAttendeeDelete = verifiedAttendeeForm(
  "delete",
  "deletion",
  async (data, form, eventId, attendeeId) => {
    await deleteAttendee(attendeeId);
    await logActivity(`Attendee deleted from '${data.event.name}'`, eventId);
    return redirect(`/admin/event/${eventId}`, "Attendee deleted", true, {
      form,
    });
  },
);

/**
 * Handle POST /admin/event/:eventId/attendee/:attendeeId/delete-incomplete
 * Deletes an attendee with an incomplete payment without requiring name confirmation.
 * Verifies the attendee is actually incomplete before deleting.
 */
const handleDeleteIncomplete = attendeeFormAction(
  async (data, _session, _form, eventId, attendeeId) => {
    const hasPaidEvent = isPaidEvent(data.event);
    const isIncomplete =
      hasPaidEvent &&
      !data.attendee.payment_id &&
      Number.parseInt(data.attendee.price_paid, 10) > 0;

    if (!isIncomplete) {
      return redirect(
        `/admin/event/${eventId}`,
        "Attendee does not have an incomplete payment",
        false,
      );
    }

    await deleteAttendee(attendeeId);
    await logActivity(
      `Incomplete attendee deleted from '${data.event.name}'`,
      eventId,
    );
    return redirect(
      `/admin/event/${eventId}`,
      "Incomplete registration removed",
      true,
    );
  },
);

/** Handle POST /admin/event/:eventId/attendee/:attendeeId/checkin */
const handleAttendeeCheckin = attendeeFormAction(
  async (data, _session, form, eventId, attendeeId) => {
    const wasCheckedIn = data.attendee.checked_in;
    const nowCheckedIn = !wasCheckedIn;

    await updateCheckedIn(attendeeId, eventId, nowCheckedIn);

    const status = nowCheckedIn ? "in" : "out";
    await logActivity(
      `Attendee checked ${status} for '${data.event.name}'`,
      eventId,
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
      `/admin/event/${eventId}${suffix}?checkin_name=${name}&checkin_status=${status}#message`,
    );
  },
);

/** Build create-attendee input from validated form values */
const buildCreateAttendeeInput = (
  values: AddAttendeeFormValues,
  event: { id: number; event_type: string; duration_days: number },
) => {
  const { name, email, phone, address, special_instructions, quantity, date } =
    values;
  const isDaily = event.event_type === "daily";
  return {
    address: address || "",
    bookings: [
      {
        date: isDaily ? date : null,
        durationDays: isDaily ? event.duration_days : undefined,
        eventId: event.id,
        quantity,
      },
    ],
    email: email || "",
    name,
    phone: phone || "",
    special_instructions: special_instructions || "",
  };
};

/** Convert a failed createAttendeeAtomic result into a redirect response */
const handleCreateAttendeeFailure = (
  result: { success: false; reason: string },
  eventId: number,
): Response => {
  if (result.reason === "encryption_error") {
    logError({
      code: ErrorCode.ENCRYPT_FAILED,
      detail: "manual add attendee",
      eventId,
    });
  }
  const errorMsg =
    result.reason === "capacity_exceeded"
      ? "Not enough spots available"
      : "Encryption error — check that DB_ENCRYPTION_KEY is configured";
  return redirect(`/admin/event/${eventId}`, errorMsg, false);
};

/** Handle POST /admin/event/:eventId/attendee (add attendee manually) */
const handleAddAttendee: TypedRouteHandler<"POST /admin/event/:eventId/attendee"> =
  createAuthedFormRoute<
    AddAttendeeFormValues,
    { eventId: number },
    EventWithCount
  >({
    form: (event) => ({
      validate: (form) =>
        validateForm<AddAttendeeFormValues>(
          form,
          getAddAttendeeFields(event.fields, event.event_type === "daily"),
        ),
    }),
    loadContext: ({ eventId }) => getEventWithCount(eventId),
    onInvalid: ({ error, params }) =>
      redirect(`/admin/event/${params.eventId}`, error, false),
    onValid: async ({ context: event, params, values }) => {
      const createResult = await createAttendeeAtomic(
        buildCreateAttendeeInput(values, event),
      );
      if (!createResult.success) {
        return handleCreateAttendeeFailure(createResult, params.eventId);
      }
      await logActivity(
        `Attendee '${values.name}' added manually`,
        params.eventId,
      );
      return redirect(
        `/admin/event/${params.eventId}`,
        `Added ${values.name}`,
        true,
      );
    },
    preprocessForm: (form) => applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS),
  });

/** Handle GET /admin/event/:eventId/attendee/:attendeeId/resend-notification */
const handleAdminResendNotificationGet = attendeePageRoute(
  adminResendNotificationPage,
);

/** Handle POST /admin/event/:eventId/attendee/:attendeeId/resend-notification */
const handleResendNotification = verifiedAttendeeForm(
  "resend-notification",
  undefined,
  async (data, form, eventId, _attendeeId) => {
    await Promise.all([
      logAndNotifyRegistration([
        { attendee: data.attendee, event: data.event },
      ]),
      logActivity(
        `Notification re-sent for attendee '${data.attendee.name}'`,
        eventId,
      ),
    ]);
    return redirect(`/admin/event/${eventId}`, "Notification re-sent", true, {
      form,
    });
  },
);

/**
 * Attendee routes
 * Event-link management: attendees-links.ts
 * Unified add/edit page: attendee-form-routes.ts
 * Refresh payment: attendees-edit.ts
 * Merge: attendees-merge.ts
 * Refunds: attendee-refunds.ts
 */
export const attendeesRoutes = defineRoutes({
  "DELETE /admin/event/:eventId/attendee/:attendeeId/delete":
    handleAttendeeDelete,
  "GET /admin/attendees/new": handleAttendeeNewGet,
  "GET /admin/attendees/:attendeeId": handleAttendeeEditGet,
  "GET /admin/attendees/:attendeeId/merge": handleMergeGet,
  "GET /admin/event/:eventId/attendee/:attendeeId/delete":
    handleAdminAttendeeDeleteGet,
  "GET /admin/event/:eventId/attendee/:attendeeId/resend-notification":
    handleAdminResendNotificationGet,
  "POST /admin/attendees/new": handleAttendeeNewPost,
  "POST /admin/attendees/:attendeeId": handleAttendeeEditPost,
  "POST /admin/attendees/:attendeeId/event/:eventId": handleUpdateEventLink,
  "POST /admin/attendees/:attendeeId/link": handleAddEventLink,
  "POST /admin/attendees/:attendeeId/merge": handleMergePost,
  "POST /admin/attendees/:attendeeId/refresh-payment": handleRefreshPayment,
  "POST /admin/attendees/:attendeeId/unlink/:eventId": handleUnlinkEvent,
  "POST /admin/event/:eventId/attendee": handleAddAttendee,
  "POST /admin/event/:eventId/attendee/:attendeeId/checkin":
    handleAttendeeCheckin,
  "POST /admin/event/:eventId/attendee/:attendeeId/delete":
    handleAttendeeDelete,
  "POST /admin/event/:eventId/attendee/:attendeeId/delete-incomplete":
    handleDeleteIncomplete,
  "POST /admin/event/:eventId/attendee/:attendeeId/resend-notification":
    handleResendNotification,
});
