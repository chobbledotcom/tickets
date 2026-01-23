/**
 * Admin event management routes
 */

import { getAttendees } from "#lib/db/attendees.ts";
import {
  deleteEvent,
  type EventInput,
  eventsTable,
  getEventWithCount,
} from "#lib/db/events.ts";
import {
  createHandler,
  deleteHandler,
  updateHandler,
} from "#lib/rest/handlers.ts";
import { defineResource } from "#lib/rest/resource.ts";
import type { EventWithCount } from "#lib/types.ts";
import { defineRoutes, type RouteParams } from "#routes/router.ts";
import {
  htmlResponse,
  isAuthenticated,
  notFoundResponse,
  redirect,
  requireSessionOr,
  withEvent,
} from "#routes/utils.ts";
import {
  adminDeleteEventPage,
  adminEventEditPage,
  adminEventPage,
} from "#templates/admin/events.tsx";
import { generateAttendeesCsv } from "#templates/csv.ts";
import { eventFields } from "#templates/fields.ts";

/** Attendee type */
type Attendee = Awaited<ReturnType<typeof getAttendees>>[number];

/** Extract event input from validated form */
const extractEventInput = (values: Record<string, unknown>): EventInput => ({
  name: values.name as string,
  description: values.description as string,
  maxAttendees: values.max_attendees as number,
  thankYouUrl: values.thank_you_url as string,
  unitPrice: values.unit_price as number | null,
  maxQuantity: values.max_quantity as number,
  webhookUrl: (values.webhook_url as string) || null,
});

/** Events resource for REST operations */
const eventsResource = defineResource({
  table: eventsTable,
  fields: eventFields,
  toInput: extractEventInput,
  nameField: "name",
  onDelete: (id) => deleteEvent(id as number),
});

/** Handle event with attendees - auth, fetch, then apply handler fn */
const withEventAttendees = async (
  request: Request,
  eventId: number,
  handler: (event: EventWithCount, attendees: Attendee[]) => Response,
): Promise<Response> => {
  if (!(await isAuthenticated(request))) {
    return redirect("/admin/");
  }
  return withEvent(eventId, async (event) =>
    handler(event, await getAttendees(eventId)),
  );
};

/**
 * Handle POST /admin/event (create event)
 */
const handleCreateEvent = createHandler(eventsResource, {
  onSuccess: () => redirect("/admin/"),
  onError: () => redirect("/admin/"),
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
  (renderPage: (event: EventWithCount, csrfToken: string) => string) =>
  (request: Request, eventId: number): Promise<Response> =>
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
  withEventAttendees(request, eventId, (event, attendees) => {
    const csv = generateAttendeesCsv(attendees);
    const filename = `${event.name.replace(/[^a-zA-Z0-9]/g, "_")}_attendees.csv`;
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  });

/** Handle GET /admin/event/:id/delete (show confirmation page) */
const handleAdminEventDeleteGet = withEventPage(adminDeleteEventPage);

/** Handle DELETE /admin/event/:id (delete event, optionally verify name) */
const handleAdminEventDelete = deleteHandler(eventsResource, {
  onSuccess: () => redirect("/admin/"),
  onVerifyFailed: (id, _row, session) =>
    eventErrorPage(
      id as number,
      adminDeleteEventPage,
      session.csrfToken,
      "Event name does not match. Please type the exact name to confirm deletion.",
    ),
  onNotFound: notFoundResponse,
});

/** Parse event ID from params */
const parseEventId = (params: RouteParams): number =>
  Number.parseInt(params.id ?? "0", 10);

/** Event routes */
export const eventsRoutes = defineRoutes({
  "POST /admin/event/": (request) => handleCreateEvent(request),
  "GET /admin/event/:id/": (request, params) =>
    handleAdminEventGet(request, parseEventId(params)),
  "GET /admin/event/:id/edit/": (request, params) =>
    handleAdminEventEditGet(request, parseEventId(params)),
  "POST /admin/event/:id/edit/": (request, params) =>
    handleAdminEventEditPost(request, parseEventId(params)),
  "GET /admin/event/:id/export/": (request, params) =>
    handleAdminEventExport(request, parseEventId(params)),
  "GET /admin/event/:id/delete/": (request, params) =>
    handleAdminEventDeleteGet(request, parseEventId(params)),
  "POST /admin/event/:id/delete/": (request, params) =>
    handleAdminEventDelete(request, parseEventId(params)),
  "DELETE /admin/event/:id/delete/": (request, params) =>
    handleAdminEventDelete(request, parseEventId(params)),
});
