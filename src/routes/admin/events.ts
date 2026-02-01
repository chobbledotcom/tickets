/**
 * Admin event management routes
 */

import type { InValue } from "@libsql/client";
import { getAllowedDomain } from "#lib/config.ts";
import {
  getEventWithActivityLog,
  logActivity,
} from "#lib/db/activityLog.ts";
import { decryptAttendees } from "#lib/db/attendees.ts";
import {
  computeSlugIndex,
  deleteEvent,
  type EventInput,
  eventsTable,
  getEventWithAttendeesRaw,
  getEventWithCount,
  isSlugTaken,
} from "#lib/db/events.ts";
import { createHandler, updateHandler } from "#lib/rest/handlers.ts";
import { defineResource } from "#lib/rest/resource.ts";
import { generateSlug } from "#lib/slug.ts";
import type { Attendee, EventFields, EventWithCount } from "#lib/types.ts";
import { defineRoutes, type RouteParams } from "#routes/router.ts";
import {
  getAuthenticatedSession,
  getPrivateKey,
  htmlResponse,
  notFoundResponse,
  redirect,
  requireAuthForm,
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

/** Generate a unique slug, retrying on collision */
const generateUniqueSlug = async (excludeEventId?: number): Promise<{ slug: string; slugIndex: string }> => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const slug = generateSlug();
    const slugIndex = await computeSlugIndex(slug);
    const taken = await isSlugTaken(slug, excludeEventId);
    if (!taken) return { slug, slugIndex };
  }
  throw new Error("Failed to generate unique slug after 10 attempts");
};

/** Extract event input from validated form (async to compute slugIndex) */
const extractEventInput = async (
  values: Record<string, unknown>,
): Promise<EventInput> => {
  const { slug, slugIndex } = await generateUniqueSlug();
  return {
    name: values.name as string,
    slug,
    slugIndex,
    maxAttendees: values.max_attendees as number,
    thankYouUrl: values.thank_you_url as string,
    unitPrice: values.unit_price as number | null,
    maxQuantity: values.max_quantity as number,
    webhookUrl: (values.webhook_url as string) || null,
    fields: (values.fields as EventFields) || "email",
  };
};

/** Extract event input for update (preserves existing slug) */
const extractEventUpdateInput = (existingSlug: string, existingSlugIndex: string) =>
  async (values: Record<string, unknown>): Promise<EventInput> => ({
    name: values.name as string,
    slug: existingSlug,
    slugIndex: existingSlugIndex,
    maxAttendees: values.max_attendees as number,
    thankYouUrl: values.thank_you_url as string,
    unitPrice: values.unit_price as number | null,
    maxQuantity: values.max_quantity as number,
    webhookUrl: (values.webhook_url as string) || null,
    fields: (values.fields as EventFields) || "email",
  });

/** Events resource for REST create operations */
const eventsResource = defineResource({
  table: eventsTable,
  fields: eventFields,
  toInput: extractEventInput,
  nameField: "name",
});

/**
 * Handle event with attendees - auth, fetch, then apply handler fn.
 * Uses batched query to fetch event + attendees in a single DB round-trip.
 */
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

  // Fetch event and attendees in single DB round-trip
  const result = await getEventWithAttendeesRaw(eventId);
  if (!result) {
    return notFoundResponse();
  }

  const attendees = await decryptAttendees(result.attendeesRaw, privateKey);
  return handler(result.event, attendees);
};

/**
 * Handle POST /admin/event (create event)
 */
const handleCreateEvent = createHandler(eventsResource, {
  onSuccess: async (row) => {
    await logActivity("Event created", row.id);
    return redirect("/admin");
  },
  onError: () => redirect("/admin"),
});

/**
 * Handle GET /admin/event/:id
 */
const handleAdminEventGet = (request: Request, eventId: number) =>
  withEventAttendees(request, eventId, (event, attendees) =>
    htmlResponse(adminEventPage(event, attendees, getAllowedDomain())),
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
const handleAdminEventEditPost = async (
  request: Request,
  eventId: number,
): Promise<Response> => {
  const auth = await requireAuthForm(request);
  if (!auth.ok) return auth.response;

  const existing = await getEventWithCount(eventId);
  if (!existing) return notFoundResponse();

  // Build a resource that preserves the existing slug
  const updateResource = defineResource({
    table: eventsTable,
    fields: eventFields,
    toInput: extractEventUpdateInput(existing.slug, existing.slug_index),
    nameField: "name",
  });

  const result = await updateResource.update(eventId, auth.form);
  if (result.ok) return redirect(`/admin/event/${result.row.id}`);
  if ("notFound" in result) return notFoundResponse();
  return eventErrorPage(eventId, adminEventEditPage, auth.session.csrfToken, result.error);
};

/**
 * Handle GET /admin/event/:id/export (CSV export)
 */
const handleAdminEventExport = (request: Request, eventId: number) =>
  withEventAttendees(request, eventId, async (event, attendees) => {
    const csv = generateAttendeesCsv(attendees);
    const filename = `${event.name.replace(/[^a-zA-Z0-9]/g, "_")}_attendees.csv`;
    await logActivity("CSV exported", event.id);
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

/** Handle POST /admin/event/:id/deactivate */
const handleAdminEventDeactivatePost = (
  request: Request,
  eventId: number,
): Promise<Response> =>
  withAuthForm(request, async (session, form) => {
    const event = await getEventWithCount(eventId);
    if (!event) {
      return notFoundResponse();
    }

    const confirmIdentifier = form.get("confirm_identifier") ?? "";
    if (!verifyIdentifier(event.name, confirmIdentifier)) {
      return eventErrorPage(
        eventId,
        adminDeactivateEventPage,
        session.csrfToken,
        "Event name does not match. Please type the exact name to confirm.",
      );
    }

    await eventsTable.update(eventId, { active: 0 });
    await logActivity("Event deactivated", eventId);
    return redirect(`/admin/event/${eventId}`);
  });

/** Handle POST /admin/event/:id/reactivate */
const handleAdminEventReactivatePost = (
  request: Request,
  eventId: number,
): Promise<Response> =>
  withAuthForm(request, async (session, form) => {
    const event = await getEventWithCount(eventId);
    if (!event) {
      return notFoundResponse();
    }

    const confirmIdentifier = form.get("confirm_identifier") ?? "";
    if (!verifyIdentifier(event.name, confirmIdentifier)) {
      return eventErrorPage(
        eventId,
        adminReactivateEventPage,
        session.csrfToken,
        "Event name does not match. Please type the exact name to confirm.",
      );
    }

    await eventsTable.update(eventId, { active: 1 });
    await logActivity("Event reactivated", eventId);
    return redirect(`/admin/event/${eventId}`);
  });

/** Handle GET /admin/event/:id/delete (show confirmation page) */
const handleAdminEventDeleteGet = withEventPage(adminDeleteEventPage);

/**
 * Handle GET /admin/event/:id/activity-log
 * Uses batched query to fetch event + activity log in a single DB round-trip.
 */
const handleAdminEventActivityLog = (
  request: Request,
  eventId: number,
): Promise<Response> =>
  requireSessionOr(request, async () => {
    const result = await getEventWithActivityLog(eventId);
    if (!result) {
      return notFoundResponse();
    }
    return htmlResponse(adminEventActivityLogPage(result.event, result.entries));
  });

/** Verify identifier matches for deletion confirmation (case-insensitive, trimmed) */
const verifyIdentifier = (expected: string, provided: string): boolean =>
  expected.trim().toLowerCase() === provided.trim().toLowerCase();

/** Check if identifier verification should be skipped (for API users) */
const needsVerify = (req: Request): boolean =>
  new URL(req.url).searchParams.get("verify_identifier") !== "false";

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
      const confirmIdentifier = form.get("confirm_identifier") ?? "";
      if (!verifyIdentifier(event.name, confirmIdentifier)) {
        return eventErrorPage(
          eventId,
          adminDeleteEventPage,
          session.csrfToken,
          "Event name does not match. Please type the exact name to confirm deletion.",
        );
      }
    }

    const attendeeCount = event.attendee_count;
    await deleteEvent(eventId);
    await logActivity(
      `Event deleted (${attendeeCount} attendee(s) removed)`,
    );
    return redirect("/admin");
  });

/** Parse event ID from params */
const parseEventId = (params: RouteParams): number =>
  Number.parseInt(params.id as string, 10);

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
