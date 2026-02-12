/**
 * Admin event management routes
 */

import { filter } from "#fp";
import { getAllowedDomain } from "#lib/config.ts";
import { formatDateLabel } from "#lib/dates.ts";
import {
  getEventWithActivityLog,
  logActivity,
} from "#lib/db/activityLog.ts";
import { deleteAllStaleReservations } from "#lib/db/processed-payments.ts";
import {
  computeSlugIndex,
  deleteEvent,
  type EventInput,
  eventsTable,
  getEventWithCount,
  isSlugTaken,
} from "#lib/db/events.ts";
import { createHandler } from "#lib/rest/handlers.ts";
import { defineResource } from "#lib/rest/resource.ts";
import { generateSlug, normalizeSlug } from "#lib/slug.ts";
import type { AdminSession, Attendee, EventWithCount } from "#lib/types.ts";
import type { EventEditFormValues, EventFormValues } from "#templates/fields.ts";
import { defineRoutes, type RouteHandlerFn } from "#routes/router.ts";
import { csvResponse, getDateFilter, verifyIdentifier, withEventAttendeesAuth } from "#routes/admin/utils.ts";
import {
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
  adminDuplicateEventPage,
  adminEventEditPage,
  adminEventPage,
  adminReactivateEventPage,
  type AttendeeFilter,
} from "#templates/admin/events.tsx";
import { generateAttendeesCsv } from "#templates/csv.ts";
import { eventFields, slugField } from "#templates/fields.ts";

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

/** Serialize comma-separated day names to JSON array string */
const serializeBookableDays = (value: string | null): string | undefined =>
  value ? JSON.stringify(value.split(",").map((d) => d.trim()).filter((d) => d)) : undefined;

/** Extract common event fields from validated form values */
const extractCommonFields = (values: EventFormValues) => ({
    name: values.name,
    description: values.description || "",
    date: values.date || "",
    location: values.location || "",
    maxAttendees: values.max_attendees,
    thankYouUrl: values.thank_you_url,
    unitPrice: values.unit_price,
    maxQuantity: values.max_quantity,
    webhookUrl: values.webhook_url || null,
    fields: values.fields || "email",
    closesAt: values.closes_at || "",
    eventType: values.event_type || undefined,
    bookableDays: serializeBookableDays(values.bookable_days),
    minimumDaysBefore: values.minimum_days_before ?? 1,
    maximumDaysAfter: values.maximum_days_after ?? 90,
});

/** Extract event input from validated form (async to compute slugIndex) */
const extractEventInput = async (
  values: EventFormValues,
): Promise<EventInput> => {
  const { slug, slugIndex } = await generateUniqueSlug();
  return { ...extractCommonFields(values), slug, slugIndex };
};

/** Extract event input for update (reads slug from form, normalizes it) */
const extractEventUpdateInput = async (
  values: EventEditFormValues,
): Promise<EventInput> => {
  const slug = normalizeSlug(values.slug);
  const slugIndex = await computeSlugIndex(slug);
  return { ...extractCommonFields(values), slug, slugIndex };
};

/** Events resource for REST create operations */
const eventsResource = defineResource({
  table: eventsTable,
  fields: eventFields,
  toInput: extractEventInput,
  nameField: "name",
});

/** Handle event with attendees - auth, fetch, then apply handler fn */
const withEventAttendees = (
  request: Request,
  eventId: number,
  handler: (ctx: { event: EventWithCount; attendees: Attendee[]; session: AdminSession }) => Response | Promise<Response>,
): Promise<Response> =>
  withEventAttendeesAuth(request, eventId, (event, attendees, session) =>
    handler({ event, attendees, session }));

/**
 * Handle POST /admin/event (create event)
 */
const handleCreateEvent = createHandler(eventsResource, {
  onSuccess: async (row) => {
    await logActivity(`Event '${row.name}' created`, row);
    return redirect("/admin");
  },
  onError: () => redirect("/admin"),
});

/** Extract check-in message params from request URL */
const getCheckinMessage = (request: Request): { name: string; status: string } | null => {
  const url = new URL(request.url);
  const name = url.searchParams.get("checkin_name");
  const status = url.searchParams.get("checkin_status");
  if (name && (status === "in" || status === "out")) {
    return { name, status };
  }
  return null;
};

/** Filter attendees by date for daily events */
const filterByDate = (attendees: Attendee[], date: string | null): Attendee[] =>
  date ? filter((a: Attendee) => a.date === date)(attendees) : attendees;

/** Collect unique dates from attendees, sorted ascending */
const getUniqueDates = (attendees: Attendee[]): { value: string; label: string }[] => {
  const dates = new Set<string>();
  for (const a of attendees) {
    if (a.date) dates.add(a.date);
  }
  return [...dates].sort().map((d) => ({ value: d, label: formatDateLabel(d) }));
};

/**
 * Handle GET /admin/event/:id (with optional filter)
 */
const handleAdminEventGet = async (request: Request, eventId: number, activeFilter: AttendeeFilter = "all") => {
  await deleteAllStaleReservations();
  return withEventAttendees(request, eventId, ({ event, attendees, session }) => {
    const dateFilter = event.event_type === "daily" ? getDateFilter(request) : null;
    const availableDates = event.event_type === "daily" ? getUniqueDates(attendees) : [];
    const filteredByDate = filterByDate(attendees, dateFilter);
    return htmlResponse(
      adminEventPage(
        event,
        filteredByDate,
        getAllowedDomain(),
        session,
        getCheckinMessage(request),
        activeFilter,
        dateFilter,
        availableDates,
      ),
    );
  });
};

/** Curried event page GET handler: renderPage -> (request, eventId) -> Response */
const withEventPage =
  (
    renderPage: (event: EventWithCount, session: AdminSession) => string,
  ): ((request: Request, eventId: number) => Promise<Response>) =>
  (request, eventId) =>
    requireSessionOr(request, (session) =>
      withEvent(eventId, (event) =>
        htmlResponse(renderPage(event, session)),
      ),
    );

/** Render event error page or 404 */
const eventErrorPage = async (
  id: number,
  renderPage: (
    event: EventWithCount,
    session: AdminSession,
    error?: string,
  ) => string,
  session: AdminSession,
  error: string,
): Promise<Response> => {
  const event = await getEventWithCount(id);
  return event
    ? htmlResponse(renderPage(event, session, error), 400)
    : notFoundResponse();
};

/** Handle GET /admin/event/:id/duplicate */
const handleAdminEventDuplicateGet = withEventPage(adminDuplicateEventPage);

/** Handle GET /admin/event/:id/edit */
const handleAdminEventEditGet = withEventPage(adminEventEditPage);

/** Handle POST /admin/event/:id/edit */
const handleAdminEventEditPost = (
  request: Request,
  eventId: number,
): Promise<Response> =>
  withAuthForm(request, async (session, form) => {
    const existing = await getEventWithCount(eventId);
    if (!existing) return notFoundResponse();

    // Build a resource that includes the slug field and validates uniqueness
    const updateResource = defineResource({
      table: eventsTable,
      fields: [...eventFields, slugField],
      toInput: extractEventUpdateInput,
      nameField: "name",
      validate: async (input, id) => {
        const taken = await isSlugTaken(input.slug, Number(id));
        return taken ? "Slug is already in use by another event" : null;
      },
    });

    const result = await updateResource.update(eventId, form);
    if (result.ok) return redirect(`/admin/event/${result.row.id}`);
    if ("notFound" in result) return notFoundResponse();
    return eventErrorPage(eventId, adminEventEditPage, session, result.error);
  });

/**
 * Handle GET /admin/event/:id/export (CSV export)
 */
const handleAdminEventExport = (request: Request, eventId: number) =>
  withEventAttendees(request, eventId, async ({ event, attendees }) => {
    const dateFilter = event.event_type === "daily" ? getDateFilter(request) : null;
    const filteredByDate = filterByDate(attendees, dateFilter);
    const isDaily = event.event_type === "daily";
    const csv = generateAttendeesCsv(filteredByDate, isDaily, {
      eventDate: event.date,
      eventLocation: event.location,
    });
    const sanitizedName = event.name.replace(/[^a-zA-Z0-9]/g, "_");
    const filename = dateFilter
      ? `${sanitizedName}_${dateFilter}_attendees.csv`
      : `${sanitizedName}_attendees.csv`;
    await logActivity(`CSV exported for '${event.name}'${dateFilter ? ` (date: ${dateFilter})` : ""}`, event);
    return csvResponse(csv, filename);
  });

/** Handle GET /admin/event/:id/deactivate (show confirmation page) */
const handleAdminEventDeactivateGet = withEventPage(adminDeactivateEventPage);

/** Handle GET /admin/event/:id/reactivate (show confirmation page) */
const handleAdminEventReactivateGet = withEventPage(adminReactivateEventPage);

/** Handle POST for event action with confirmation */
const handleEventWithConfirmation = (
  request: Request,
  eventId: number,
  renderPage: (event: EventWithCount, session: AdminSession, error?: string) => string,
  errorMsg: string,
  action: (event: EventWithCount) => Promise<Response>,
): Promise<Response> =>
  withAuthForm(request, async (session, form) => {
    const event = await getEventWithCount(eventId);
    if (!event) {
      return notFoundResponse();
    }

    const confirmIdentifier = form.get("confirm_identifier") ?? "";
    if (!verifyIdentifier(event.name, confirmIdentifier)) {
      return eventErrorPage(eventId, renderPage, session, errorMsg);
    }

    return action(event);
  });

const CONFIRM_NAME_MSG = "Event name does not match. Please type the exact name to confirm.";

/** Handle POST /admin/event/:id/deactivate */
const handleAdminEventDeactivatePost = (
  request: Request,
  eventId: number,
): Promise<Response> =>
  handleEventWithConfirmation(request, eventId, adminDeactivateEventPage, CONFIRM_NAME_MSG, async (event) => {
    await eventsTable.update(eventId, { active: 0 });
    await logActivity(`Event '${event.name}' deactivated`, eventId);
    return redirect(`/admin/event/${eventId}`);
  });

/** Handle POST /admin/event/:id/reactivate */
const handleAdminEventReactivatePost = (
  request: Request,
  eventId: number,
): Promise<Response> =>
  handleEventWithConfirmation(request, eventId, adminReactivateEventPage, CONFIRM_NAME_MSG, async (event) => {
    await eventsTable.update(eventId, { active: 1 });
    await logActivity(`Event '${event.name}' reactivated`, eventId);
    return redirect(`/admin/event/${eventId}`);
  });

/** Handle GET /admin/event/:id/delete (show confirmation page) */
const handleAdminEventDeleteGet = withEventPage(adminDeleteEventPage);

/**
 * Handle GET /admin/event/:id/log
 * Uses batched query to fetch event + activity log in a single DB round-trip.
 */
const handleAdminEventLog = (
  request: Request,
  eventId: number,
): Promise<Response> =>
  requireSessionOr(request, async (session) => {
    const result = await getEventWithActivityLog(eventId);
    if (!result) {
      return notFoundResponse();
    }
    return htmlResponse(adminEventActivityLogPage(result.event, result.entries, session));
  });

/** Check if identifier verification should be skipped (for API users) */
const needsVerify = (req: Request): boolean =>
  new URL(req.url).searchParams.get("verify_identifier") !== "false";

/** Perform event deletion */
const performDelete = async (event: EventWithCount): Promise<Response> => {
  const attendeeCount = event.attendee_count;
  await deleteEvent(event.id);
  await logActivity(
    `Event '${event.name}' deleted (${attendeeCount} attendee(s) removed)`,
  );
  return redirect("/admin");
};

/** Handle DELETE /admin/event/:id (delete event with logging) */
const handleAdminEventDelete = (
  request: Request,
  eventId: number,
): Promise<Response> =>
  needsVerify(request)
    ? handleEventWithConfirmation(
        request, eventId, adminDeleteEventPage,
        "Event name does not match. Please type the exact name to confirm deletion.",
        performDelete,
      )
    : withAuthForm(request, async () => {
        const event = await getEventWithCount(eventId);
        return event ? performDelete(event) : notFoundResponse();
      });

/** Bind :id param to an event handler */
type EventHandler = (request: Request, eventId: number) => Response | Promise<Response>;
const eventRoute = (handler: EventHandler): RouteHandlerFn =>
  (request, params) => handler(request, params.id as number);

/** Event routes */
export const eventsRoutes = defineRoutes({
  "POST /admin/event": (request) => handleCreateEvent(request),
  "GET /admin/event/:id/in": eventRoute((req, id) => handleAdminEventGet(req, id, "in")),
  "GET /admin/event/:id/out": eventRoute((req, id) => handleAdminEventGet(req, id, "out")),
  "GET /admin/event/:id": eventRoute(handleAdminEventGet),
  "GET /admin/event/:id/duplicate": eventRoute(handleAdminEventDuplicateGet),
  "GET /admin/event/:id/edit": eventRoute(handleAdminEventEditGet),
  "POST /admin/event/:id/edit": eventRoute(handleAdminEventEditPost),
  "GET /admin/event/:id/export": eventRoute(handleAdminEventExport),
  "GET /admin/event/:id/log": eventRoute(handleAdminEventLog),
  "GET /admin/event/:id/deactivate": eventRoute(handleAdminEventDeactivateGet),
  "POST /admin/event/:id/deactivate": eventRoute(handleAdminEventDeactivatePost),
  "GET /admin/event/:id/reactivate": eventRoute(handleAdminEventReactivateGet),
  "POST /admin/event/:id/reactivate": eventRoute(handleAdminEventReactivatePost),
  "GET /admin/event/:id/delete": eventRoute(handleAdminEventDeleteGet),
  "POST /admin/event/:id/delete": eventRoute(handleAdminEventDelete),
  "DELETE /admin/event/:id/delete": eventRoute(handleAdminEventDelete),
});
