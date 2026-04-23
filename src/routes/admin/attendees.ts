/**
 * Admin attendee management routes
 */

import { logActivity } from "#lib/db/activityLog.ts";
import {
  createAttendeeAtomic,
  deleteAttendee,
  updateCheckedIn,
} from "#lib/db/attendees.ts";
import { getEventWithCount } from "#lib/db/events.ts";
import { ATTENDEE_DEMO_FIELDS, applyDemoOverrides } from "#lib/demo.ts";
import { validateForm } from "#lib/forms.tsx";
import { ErrorCode, logError } from "#lib/logger.ts";
import { type AdminSession, isPaidEvent } from "#lib/types.ts";
import { logAndNotifyRegistration } from "#lib/webhook.ts";
import { AUTH_FORM, withAuth } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { htmlResponse, redirect, redirectResponse } from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import {
  adminDeleteAttendeePage,
  adminResendNotificationPage,
} from "#templates/admin/attendees.tsx";
import {
  type AddAttendeeFormValues,
  getAddAttendeeFields,
} from "#templates/fields.ts";
import {
  handleEditAttendeeGet,
  handleEditAttendeePost,
  handleRefreshPayment,
} from "./attendees-edit.ts";
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
import { withEntityFromParam } from "./entity-handlers.ts";

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
  eventId: number,
  isDaily: boolean,
) => {
  const { name, email, phone, address, special_instructions, quantity, date } =
    values;
  return {
    address: address || "",
    bookings: [{ date: isDaily ? date : null, eventId, quantity }],
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
const handleAddAttendee: TypedRouteHandler<
  "POST /admin/event/:eventId/attendee"
> = (request, params) =>
  withAuth(request, AUTH_FORM, (_session, form) =>
    withEntityFromParam(params.eventId, getEventWithCount, async (event) => {
      const isDaily = event.event_type === "daily";
      const fields = getAddAttendeeFields(event.fields, isDaily);
      applyDemoOverrides(form, ATTENDEE_DEMO_FIELDS);

      const result = validateForm<AddAttendeeFormValues>(form, fields);
      if (!result.valid) {
        return redirect(`/admin/event/${params.eventId}`, result.error, false);
      }

      const createResult = await createAttendeeAtomic(
        buildCreateAttendeeInput(result.values, params.eventId, isDaily),
      );

      if (!createResult.success) {
        return handleCreateAttendeeFailure(createResult, params.eventId);
      }

      await logActivity(
        `Attendee '${result.values.name}' added manually`,
        params.eventId,
      );
      return redirect(
        `/admin/event/${params.eventId}`,
        `Added ${result.values.name}`,
        true,
      );
    }),
  );

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
 * Edit page + refresh payment: attendees-edit.ts
 * Merge: attendees-merge.ts
 * Refunds: attendee-refunds.ts
 */
export const attendeesRoutes = defineRoutes({
  "DELETE /admin/event/:eventId/attendee/:attendeeId/delete":
    handleAttendeeDelete,
  "GET /admin/attendees/:attendeeId": handleEditAttendeeGet,
  "GET /admin/attendees/:attendeeId/merge": handleMergeGet,
  "GET /admin/event/:eventId/attendee/:attendeeId/delete":
    handleAdminAttendeeDeleteGet,
  "GET /admin/event/:eventId/attendee/:attendeeId/resend-notification":
    handleAdminResendNotificationGet,
  "POST /admin/attendees/:attendeeId": handleEditAttendeePost,
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
