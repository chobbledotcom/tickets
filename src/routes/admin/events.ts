/**
 * Admin event management routes
 */

import type { InValue } from "@libsql/client";
import {
  getEventActivityLog,
  logActivity,
} from "#lib/db/activityLog.ts";
import { getAttendees } from "#lib/db/attendees.ts";
import {
  deleteEvent,
  type EventInput,
  eventsTable,
  getEventWithCount,
  isSlugTaken,
} from "#lib/db/events.ts";
import { createHandler, updateHandler } from "#lib/rest/handlers.ts";
import { defineResource } from "#lib/rest/resource.ts";
import type { Attendee, EventWithCount } from "#lib/types.ts";
import { defineRoutes, type RouteParams } from "#routes/router.ts";
import {
  getAuthenticatedSession,
  getPrivateKey,
  htmlResponse,
  notFoundResponse,
  redirect,
  requireSessionOr,
  withAuthForm,
  withEvent,
} from "#routes/utils.ts";
import { adminEventActivityLogPage } from "#templates/admin/activityLog.tsx";
import {
  adminDeactivateEventPage,
  adminDeleteEventPage,
  adminEventEditPage,
  adminEventPage,
  adminReactivateEventPage,
} from "#templates/admin/events.tsx";
import { generateAttendeesCsv } from "#templates/csv.ts";
import { eventFields } from "#templates/fields.ts";

/** Extract event input from validated form */
const extractEventInput = (values: Record<string, unknown>): EventInput => ({
  slug: values.slug as string,
  name: values.name as string,
  description: values.description as string,
  maxAttendees: values.max_attendees as number,
  thankYouUrl: values.thank_you_url as string,
  unitPrice: values.unit_price as number | null,
  maxQuantity: values.max_quantity as number,
  webhookUrl: (values.webhook_url as string) || null,
});

/** Validate slug uniqueness */
const validateEventInput = async (
  input: EventInput,
  id?: InValue,
): Promise<string | null> => {
  const taken = await isSlugTaken(input.slug, id as number | undefined);
  return taken
    ? "This slug is already in use. Please choose a different one."
    : null;
};

/** Events resource for REST operations */
const eventsResource = defineResource({
  table: eventsTable,
  fields: eventFields,
  toInput: extractEventInput,
  nameField: "name",
  onDelete: (id) => deleteEvent(id as number),
  validate: validateEventInput,
});

/** Handle event with attendees - auth, fetch, then apply handler fn */
const withEventAttendees = async (
  request: Request,
  eventId: number,
  handler: (event: EventWithCount, attendees: Attendee[]) => Response | Promise<Response>,
): Promise<Response> => {
  const session = await getAuthenticatedSession(request);
  if (!session) {
    return redirect("/admin");
  }

  const privateKey = await getPrivateKey(session.token, session.wrappedDataKey);
  if (!privateKey) {
    // Session exists but can't derive private key - need to re-login
    return redirect("/admin");
  }

  return withEvent(eventId, async (event) =>
    handler(event, await getAttendees(eventId, privateKey)),
  );
};

/**
 * Handle POST /admin/event (create event)
 */
const handleCreateEvent = createHandler(eventsResource, {
  onSuccess: async (row) => {
    await logActivity(`Created event '${row.name}'`, row.id);
    return redirect("/admin");
  },
  onError: () => redirect("/admin"),
});

/**
 * Handle GET /admin/event/:id
 */
const handleAdminEventGet = (request: Request, eventId: number) =>
  withEventAttendees(request, eventId, (event, attendees) =>
    htmlResponse(adminEventPage(event, attendees)),
  );

/** Curried event page GET handler: renderPage -> (request, eventId) -> Response */
const withEventPage =
  (
    renderPage: (event: EventWithCount, csrfToken: string) => string,
  ): ((request: Request, eventId: number) => Promise<Response>) =>
  (request, eventId) =>
    requireSessionOr(request, (session) =>
      withEvent(eventId, (event) =>
        htmlResponse(renderPage(event, session.csrfToken)),
      ),
    );

/** Render event error page or 404 */
const eventErrorPage = async (
  id: number,
  renderPage: (
    event: EventWithCount,
    csrfToken: string,
    error: string,
  ) => string,
  csrfToken: string,
  error: string,
): Promise<Response> => {
  const event = await getEventWithCount(id);
  return event
    ? htmlResponse(renderPage(event, csrfToken, error), 400)
    : notFoundResponse();
};

/** Handle GET /admin/event/:id/edit */
const handleAdminEventEditGet = withEventPage(adminEventEditPage);

/** Handle POST /admin/event/:id/edit */
const handleAdminEventEditPost = updateHandler(eventsResource, {
  onSuccess: (row) => redirect(`/admin/event/${row.id}`),
  onError: (id, error, session) =>
    eventErrorPage(id as number, adminEventEditPage, session.csrfToken, error),
  onNotFound: notFoundResponse,
});

/**
 * Handle GET /admin/event/:id/export (CSV export)
 */
const handleAdminEventExport = (request: Request, eventId: number) =>
  withEventAttendees(request, eventId, async (event, attendees) => {
    const csv = generateAttendeesCsv(attendees);
    const filename = `${event.name.replace(/[^a-zA-Z0-9]/g, "_")}_attendees.csv`;
    await logActivity(`Exported CSV for '${event.name}'`, event.id);
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  });

/** Handle GET /admin/event/:id/deactivate (show confirmation page) */
const handleAdminEventDeactivateGet = withEventPage(adminDeactivateEventPage);

/** Handle GET /admin/event/:id/reactivate (show confirmation page) */
const handleAdminEventReactivateGet = withEventPage(adminReactivateEventPage);

/** Create handler to set event active status */
const setActiveHandler =
  (active: number) =>
  (request: Request, eventId: number): Promise<Response> =>
    withAuthForm(request, () =>
      withEvent(eventId, async () => {
        await eventsTable.update(eventId, { active });
        return redirect(`/admin/event/${eventId}`);
      }),
    );

/** Handle POST /admin/event/:id/deactivate */
const handleAdminEventDeactivatePost = setActiveHandler(0);

/** Handle POST /admin/event/:id/reactivate */
const handleAdminEventReactivatePost = setActiveHandler(1);

/** Handle GET /admin/event/:id/delete (show confirmation page) */
const handleAdminEventDeleteGet = withEventPage(adminDeleteEventPage);

/** Handle GET /admin/event/:id/activity-log */
const handleAdminEventActivityLog = (
  request: Request,
  eventId: number,
): Promise<Response> =>
  requireSessionOr(request, async () => {
    const event = await getEventWithCount(eventId);
    if (!event) {
      return notFoundResponse();
    }
    const entries = await getEventActivityLog(eventId);
    return htmlResponse(adminEventActivityLogPage(event, entries));
  });

/** Verify name matches for deletion confirmation (case-insensitive, trimmed) */
const verifyName = (expected: string, provided: string): boolean =>
  expected.trim().toLowerCase() === provided.trim().toLowerCase();

/** Check if name verification should be skipped (for API users) */
const needsVerify = (req: Request): boolean =>
  new URL(req.url).searchParams.get("verify_name") !== "false";

/** Handle DELETE /admin/event/:id (delete event with logging) */
const handleAdminEventDelete = (
  request: Request,
  eventId: number,
): Promise<Response> =>
  withAuthForm(request, async (session, form) => {
    const event = await getEventWithCount(eventId);
    if (!event) {
      return notFoundResponse();
    }

    if (needsVerify(request)) {
      const confirmName = form.get("confirm_name") ?? "";
      if (!verifyName(event.name, confirmName)) {
        return eventErrorPage(
          eventId,
          adminDeleteEventPage,
          session.csrfToken,
          "Event name does not match. Please type the exact name to confirm deletion.",
        );
      }
    }

    const attendeeCount = event.attendee_count;
    const eventName = event.name;
    await deleteEvent(eventId);
    await logActivity(
      `Deleted event '${eventName}' and ${attendeeCount} attendee(s)`,
    );
    return redirect("/admin");
  });

/** Parse event ID from params */
const parseEventId = (params: RouteParams): number =>
  Number.parseInt(params.id ?? "0", 10);

/** Event routes */
export const eventsRoutes = defineRoutes({
  "POST /admin/event": (request) => handleCreateEvent(request),
  "GET /admin/event/:id": (request, params) =>
    handleAdminEventGet(request, parseEventId(params)),
  "GET /admin/event/:id/edit": (request, params) =>
    handleAdminEventEditGet(request, parseEventId(params)),
  "POST /admin/event/:id/edit": (request, params) =>
    handleAdminEventEditPost(request, parseEventId(params)),
  "GET /admin/event/:id/export": (request, params) =>
    handleAdminEventExport(request, parseEventId(params)),
  "GET /admin/event/:id/activity-log": (request, params) =>
    handleAdminEventActivityLog(request, parseEventId(params)),
  "GET /admin/event/:id/deactivate": (request, params) =>
    handleAdminEventDeactivateGet(request, parseEventId(params)),
  "POST /admin/event/:id/deactivate": (request, params) =>
    handleAdminEventDeactivatePost(request, parseEventId(params)),
  "GET /admin/event/:id/reactivate": (request, params) =>
    handleAdminEventReactivateGet(request, parseEventId(params)),
  "POST /admin/event/:id/reactivate": (request, params) =>
    handleAdminEventReactivatePost(request, parseEventId(params)),
  "GET /admin/event/:id/delete": (request, params) =>
    handleAdminEventDeleteGet(request, parseEventId(params)),
  "POST /admin/event/:id/delete": (request, params) =>
    handleAdminEventDelete(request, parseEventId(params)),
  "DELETE /admin/event/:id/delete": (request, params) =>
    handleAdminEventDelete(request, parseEventId(params)),
});
