/**
 * Admin event management routes
 */

import { filter } from "#fp";
import { getAllowedDomain } from "#lib/config.ts";
import { toMinorUnits } from "#lib/currency.ts";
import { formatDateLabel, normalizeDatetime } from "#lib/dates.ts";
import { getEventWithActivityLog, logActivity } from "#lib/db/activityLog.ts";
import {
  computeSlugIndex,
  deleteEvent,
  type EventInput,
  eventsTable,
  getEventWithCount,
  isSlugTaken,
} from "#lib/db/events.ts";
import { getAllGroups, groupsTable } from "#lib/db/groups.ts";
import { deleteAllStaleReservations } from "#lib/db/processed-payments.ts";
import { getPhonePrefixFromDb } from "#lib/db/settings.ts";
import {
  applyDemoOverrides,
  EVENT_DEMO_FIELDS,
  isDemoMode,
} from "#lib/demo.ts";
import { defineResource } from "#lib/rest/resource.ts";
import { generateUniqueSlug, normalizeSlug } from "#lib/slug.ts";
import {
  IMAGE_ERROR_MESSAGES,
  isStorageEnabled,
  tryDeleteImage,
  uploadImage,
  validateImage,
} from "#lib/storage.ts";
import type {
  AdminSession,
  Attendee,
  EventWithCount,
  Group,
} from "#lib/types.ts";
import {
  csvResponse,
  type DecryptMode,
  getDateFilter,
  verifyIdentifier,
  withEventAttendeesAuth,
} from "#routes/admin/utils.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  formDataToParams,
  getSearchParam,
  htmlResponse,
  notFoundResponse,
  orNotFound,
  redirect,
  redirectWithSuccess,
  requireSessionOr,
  withAuthForm,
  withAuthMultipartForm,
  withEventPage,
} from "#routes/utils.ts";
import { adminEventActivityLogPage } from "#templates/admin/activityLog.tsx";
import {
  type AddAttendeeMessage,
  type AttendeeFilter,
  adminDeactivateEventPage,
  adminDeleteEventPage,
  adminDuplicateEventPage,
  adminEventEditPage,
  adminEventNewPage,
  adminEventPage,
  adminReactivateEventPage,
} from "#templates/admin/events.tsx";
import { generateAttendeesCsv } from "#templates/csv.ts";
import type {
  EventEditFormValues,
  EventFormValues,
} from "#templates/fields.ts";
import { eventFields, groupIdField, slugField } from "#templates/fields.ts";

/** Generate a unique event slug, retrying on collision */
const generateUniqueEventSlug = (excludeEventId?: number) =>
  generateUniqueSlug(computeSlugIndex, (slug) =>
    isSlugTaken(slug, excludeEventId),
  );

/** Parse comma-separated day names to string array */
const parseBookableDays = (value: string): string[] | undefined =>
  value
    ? value
        .split(",")
        .map((d) => d.trim())
        .filter((d) => d)
    : undefined;

/** Extract common event fields from validated form values, normalizing datetimes to UTC */
const extractCommonFields = (values: EventFormValues) => {
  const rawDate = values.date ?? "";
  const date = rawDate ? normalizeDatetime(rawDate, "date") : rawDate;
  const unitPrice = values.unit_price
    ? toMinorUnits(Number.parseFloat(values.unit_price))
    : undefined;
  const closesAt = values.closes_at
    ? normalizeDatetime(values.closes_at, "closes_at")
    : values.closes_at;
  const webhookUrl = isDemoMode() ? "" : values.webhook_url || "";
  return {
    name: values.name,
    description: values.description,
    date,
    location: values.location,
    groupId: Number(values.group_id) || 0,
    maxAttendees: values.max_attendees,
    thankYouUrl: values.thank_you_url || "",
    unitPrice,
    maxQuantity: values.max_quantity,
    webhookUrl,
    fields: values.fields || "email",
    closesAt,
    eventType: values.event_type || undefined,
    bookableDays: parseBookableDays(values.bookable_days),
    minimumDaysBefore: values.minimum_days_before ?? 1,
    maximumDaysAfter: values.maximum_days_after ?? 90,
    nonTransferable: values.non_transferable === "1",
    canPayMore: values.can_pay_more === "1",
    hidden: values.hidden === "1",
  };
};

/** Extract event input from validated form (async to compute slugIndex) */
const extractEventInput = async (
  values: EventFormValues,
): Promise<EventInput> => {
  const { slug, slugIndex } = await generateUniqueEventSlug();
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

/** Validate that the referenced group exists (when group_id is non-zero) */
const validateGroupExists = async (
  input: EventInput,
): Promise<string | null> => {
  if (input.groupId && input.groupId !== 0) {
    const group = await groupsTable.findById(input.groupId);
    if (!group) return "Selected group does not exist";
  }
  return null;
};

/** Events resource for REST create operations */
const eventsResource = defineResource({
  table: eventsTable,
  fields: [...eventFields, groupIdField],
  toInput: extractEventInput,
  nameField: "name",
  validate: validateGroupExists,
});

/** Process image from multipart form and attach to event. Returns error message if validation fails. */
const processFormImage = async (
  formData: FormData,
  eventId: number,
  existingImageUrl?: string,
): Promise<string | null> => {
  if (!isStorageEnabled()) return null;
  const entry = formData.get("image");
  if (!(entry instanceof File) || entry.size === 0) return null;
  const file = entry;

  const data = new Uint8Array(await file.arrayBuffer());
  const validation = validateImage(data, file.type);
  if (!validation.valid) return IMAGE_ERROR_MESSAGES[validation.error];

  if (existingImageUrl) {
    await tryDeleteImage(existingImageUrl, eventId, "old image cleanup");
  }

  const filename = await uploadImage(data, validation.detectedType);
  await eventsTable.update(eventId, { imageUrl: filename });
  await logActivity("Image uploaded for event", eventId);
  return null;
};

/** Handle event with attendees - auth, fetch, then apply handler fn */
const withEventAttendees = (
  request: Request,
  eventId: number,
  handler: (ctx: {
    event: EventWithCount;
    attendees: Attendee[];
    session: AdminSession;
  }) => Response | Promise<Response>,
  mode: DecryptMode = "full",
): Promise<Response> =>
  withEventAttendeesAuth(
    request,
    eventId,
    (event, attendees, session) => handler({ event, attendees, session }),
    mode,
  );

/**
 * Handle GET /admin/event/new (show create event form)
 */
const handleNewEventGet: TypedRouteHandler<"GET /admin/event/new"> = (
  request,
) =>
  requireSessionOr(request, async (session) => {
    const groups = await getAllGroups();
    return htmlResponse(adminEventNewPage(groups, session));
  });

/**
 * Handle POST /admin/event (create event)
 */
const handleCreateEvent: TypedRouteHandler<"POST /admin/event"> = (request) =>
  withAuthMultipartForm(request, async (session, formData) => {
    const form = formDataToParams(formData);
    applyDemoOverrides(form, EVENT_DEMO_FIELDS);
    const result = await eventsResource.create(form);
    if (!result.ok) {
      const groups = await getAllGroups();
      return htmlResponse(
        adminEventNewPage(groups, session, result.error),
        400,
      );
    }
    await logActivity(`Event '${result.row.name}' created`, result.row);
    const imageError = await processFormImage(formData, result.row.id);
    if (imageError) {
      return redirect(`/admin?image_error=${encodeURIComponent(imageError)}`);
    }
    return redirectWithSuccess("/admin", "Event created");
  });

/** Extract check-in message params from request URL */
const getCheckinMessage = (
  request: Request,
): { name: string; status: string } | null => {
  const url = new URL(request.url);
  const name = url.searchParams.get("checkin_name");
  const status = url.searchParams.get("checkin_status");
  if (name && (status === "in" || status === "out")) {
    return { name, status };
  }
  return null;
};

/** Extract add-attendee result message from request URL */
const getAddAttendeeMessage = (request: Request): AddAttendeeMessage => {
  const url = new URL(request.url);
  const added = url.searchParams.get("added");
  if (added) return { name: added };
  const edited = url.searchParams.get("edited");
  if (edited) return { edited };
  const error = url.searchParams.get("add_error");
  if (error) return { error };
  return null;
};

/** Filter attendees by date for daily events */
const filterByDate = (
  attendees: Attendee[],
  date: string | null,
): Attendee[] =>
  date ? filter((a: Attendee) => a.date === date)(attendees) : attendees;

/** Collect unique dates from attendees, sorted ascending */
const getUniqueDates = (
  attendees: Attendee[],
): { value: string; label: string }[] => {
  const dates = new Set<string>();
  for (const a of attendees) {
    if (a.date) dates.add(a.date);
  }
  return [...dates]
    .sort()
    .map((d) => ({ value: d, label: formatDateLabel(d) }));
};

/** Get date filter and filtered attendees for daily events */
const applyDateFilter = (
  event: EventWithCount,
  attendees: Attendee[],
  request: Request,
) => {
  const dateFilter =
    event.event_type === "daily" ? getDateFilter(request) : null;
  const availableDates =
    event.event_type === "daily" ? getUniqueDates(attendees) : [];
  return {
    dateFilter,
    availableDates,
    filteredByDate: filterByDate(attendees, dateFilter),
  };
};

/** Render event page with attendee list and optional filter */
const renderEventPage = async (
  request: Request,
  { id }: { id: number },
  activeFilter: AttendeeFilter = "all",
) => {
  // Run stale reservation cleanup concurrently with event data loading.
  // These are independent: cleanup targets processed_payments with NULL attendee_id,
  // which doesn't affect the attendees query. Saves 1 HTTP round-trip.
  const [, response] = await Promise.all([
    deleteAllStaleReservations(),
    withEventAttendees(
      request,
      id,
      async ({ event, attendees, session }) => {
        const { dateFilter, availableDates, filteredByDate } = applyDateFilter(
          event,
          attendees,
          request,
        );
        const imageError = getSearchParam(request, "image_error");
        const successMessage = getSearchParam(request, "success");
        const phonePrefix = await getPhonePrefixFromDb();
        return htmlResponse(
          adminEventPage({
            event,
            attendees: filteredByDate,
            allowedDomain: getAllowedDomain(),
            session,
            checkinMessage: getCheckinMessage(request),
            activeFilter,
            dateFilter,
            availableDates,
            addAttendeeMessage: getAddAttendeeMessage(request),
            imageError,
            phonePrefix,
            successMessage,
          }),
        );
      },
      "table",
    ),
  ]);
  return response;
};

/** Render event error page */
const eventErrorPage = (
  event: EventWithCount,
  renderPage: (
    event: EventWithCount,
    session: AdminSession,
    error?: string,
  ) => string,
  session: AdminSession,
  error: string,
): Response => htmlResponse(renderPage(event, session, error), 400);

/** Handle GET /admin/event/:id/duplicate */
const getEventAndGroups = async (
  eventId: number,
): Promise<{ event: EventWithCount; groups: Group[] } | null> => {
  const [event, groups] = await Promise.all([
    getEventWithCount(eventId),
    getAllGroups(),
  ]);
  return event ? { event, groups } : null;
};

const withEventAndGroupsPage =
  (
    renderPage: (
      event: EventWithCount,
      groups: Group[],
      session: AdminSession,
    ) => string,
  ): TypedRouteHandler<"GET /admin/event/:id"> =>
  (request, params) =>
    requireSessionOr(request, (session) =>
      orNotFound(getEventAndGroups(params.id), (ctx) =>
        htmlResponse(renderPage(ctx.event, ctx.groups, session)),
      ),
    );

const handleAdminEventDuplicateGet: TypedRouteHandler<"GET /admin/event/:id/duplicate"> =
  withEventAndGroupsPage(adminDuplicateEventPage);

/** Handle GET /admin/event/:id/edit */
const handleAdminEventEditGet: TypedRouteHandler<"GET /admin/event/:id/edit"> =
  withEventAndGroupsPage(adminEventEditPage);

/** Handle POST /admin/event/:id/edit */
const handleAdminEventEditPost: TypedRouteHandler<
  "POST /admin/event/:id/edit"
> = (request, { id }) =>
  withAuthMultipartForm(request, async (session, formData) => {
    const existing = await getEventWithCount(id);
    if (!existing) return notFoundResponse();

    const form = formDataToParams(formData);
    applyDemoOverrides(form, EVENT_DEMO_FIELDS);

    // Build a resource that includes the slug field and validates uniqueness
    const updateResource = defineResource({
      table: eventsTable,
      fields: [...eventFields, slugField, groupIdField],
      toInput: extractEventUpdateInput,
      nameField: "name",
      validate: async (input, existingId) => {
        const taken = await isSlugTaken(input.slug, Number(existingId));
        if (taken) return "Slug is already in use by another event";
        return validateGroupExists(input);
      },
    });

    const result = await updateResource.update(id, form);
    if (result.ok) {
      await logActivity(`Event '${result.row.name}' updated`, result.row);
      const imageError = await processFormImage(
        formData,
        id,
        existing.image_url,
      );
      if (imageError) {
        return redirect(
          `/admin/event/${result.row.id}?image_error=${encodeURIComponent(imageError)}`,
        );
      }
      return redirectWithSuccess(
        `/admin/event/${result.row.id}`,
        "Event updated",
      );
    }
    if ("notFound" in result) return notFoundResponse();

    const ctx = await getEventAndGroups(id);
    return ctx
      ? htmlResponse(
          adminEventEditPage(ctx.event, ctx.groups, session, result.error),
          400,
        )
      : notFoundResponse();
  });

/**
 * Handle GET /admin/event/:id/export (CSV export)
 */
const handleAdminEventExport: TypedRouteHandler<
  "GET /admin/event/:id/export"
> = (request, { id }) =>
  withEventAttendees(request, id, async ({ event, attendees }) => {
    const { dateFilter, filteredByDate } = applyDateFilter(
      event,
      attendees,
      request,
    );
    const isDaily = event.event_type === "daily";
    const csv = generateAttendeesCsv(filteredByDate, isDaily, {
      eventDate: event.date,
      eventLocation: event.location,
    });
    const sanitizedName = event.name.replace(/[^a-zA-Z0-9]/g, "_");
    const filename = dateFilter
      ? `${sanitizedName}_${dateFilter}_attendees.csv`
      : `${sanitizedName}_attendees.csv`;
    await logActivity(
      `CSV exported for '${event.name}'${dateFilter ? ` (date: ${dateFilter})` : ""}`,
      event,
    );
    return csvResponse(csv, filename);
  });

/** Handle GET /admin/event/:id/deactivate (show confirmation page) */
const handleAdminEventDeactivateGet = withEventPage(adminDeactivateEventPage);

/** Handle GET /admin/event/:id/reactivate (show confirmation page) */
const handleAdminEventReactivateGet = withEventPage(adminReactivateEventPage);

/** Handle POST for event action with confirmation */
const handleEventWithConfirmation = (
  request: Request,
  id: number,
  renderPage: (
    event: EventWithCount,
    session: AdminSession,
    error?: string,
  ) => string,
  errorMsg: string,
  action: (event: EventWithCount) => Promise<Response>,
): Promise<Response> =>
  withAuthForm(request, (session, form) =>
    orNotFound(getEventWithCount(id), (event) => {
      const confirmIdentifier = form.get("confirm_identifier") ?? "";
      if (!verifyIdentifier(event.name, confirmIdentifier)) {
        return eventErrorPage(event, renderPage, session, errorMsg);
      }
      return action(event);
    }),
  );

const CONFIRM_NAME_MSG =
  "Event name does not match. Please type the exact name to confirm.";

/** Factory for event toggle handlers (deactivate/reactivate) */
const eventToggleHandler =
  (
    renderPage: typeof adminDeactivateEventPage,
    active: boolean,
    verb: string,
  ): TypedRouteHandler<"POST /admin/event/:id/deactivate"> =>
  (request, { id }) =>
    handleEventWithConfirmation(
      request,
      id,
      renderPage,
      CONFIRM_NAME_MSG,
      async (event) => {
        await eventsTable.update(id, { active });
        await logActivity(`Event '${event.name}' ${verb}`, id);
        return redirectWithSuccess(`/admin/event/${id}`, `Event ${verb}`);
      },
    );

/** Handle POST /admin/event/:id/deactivate */
const handleAdminEventDeactivatePost = eventToggleHandler(
  adminDeactivateEventPage,
  false,
  "deactivated",
);

/** Handle POST /admin/event/:id/reactivate */
const handleAdminEventReactivatePost = eventToggleHandler(
  adminReactivateEventPage,
  true,
  "reactivated",
);

/** Handle GET /admin/event/:id/delete (show confirmation page) */
const handleAdminEventDeleteGet = withEventPage(adminDeleteEventPage);

/**
 * Handle GET /admin/event/:id/log
 * Uses batched query to fetch event + activity log in a single DB round-trip.
 */
const handleAdminEventLog: TypedRouteHandler<"GET /admin/event/:id/log"> = (
  request,
  { id },
) =>
  requireSessionOr(request, (session) =>
    orNotFound(getEventWithActivityLog(id), (result) =>
      htmlResponse(
        adminEventActivityLogPage(result.event, result.entries, session),
      ),
    ),
  );

/** Perform event deletion */
const performDelete = async (event: EventWithCount): Promise<Response> => {
  const attendeeCount = event.attendee_count;
  await deleteEvent(event.id);
  await logActivity(
    `Event '${event.name}' deleted (${attendeeCount} attendee(s) removed)`,
  );
  return redirectWithSuccess("/admin", "Event deleted");
};

/** Handle DELETE /admin/event/:id (delete event with logging) */
const handleAdminEventDelete: TypedRouteHandler<
  "POST /admin/event/:id/delete"
> = (request, { id }) =>
  getSearchParam(request, "verify_identifier") !== "false"
    ? handleEventWithConfirmation(
        request,
        id,
        adminDeleteEventPage,
        "Event name does not match. Please type the exact name to confirm deletion.",
        performDelete,
      )
    : withAuthForm(request, () =>
        orNotFound(getEventWithCount(id), performDelete),
      );

/** Handle POST /admin/event/:id/image/delete (delete event image) */
const handleImageDelete: TypedRouteHandler<
  "POST /admin/event/:id/image/delete"
> = (request, { id }) =>
  withAuthForm(request, () =>
    orNotFound(getEventWithCount(id), async (event) => {
      if (event.image_url) {
        await tryDeleteImage(event.image_url, event.id, "image removal");
        await eventsTable.update(id, { imageUrl: "" });
        await logActivity(`Image removed for '${event.name}'`, event);
      }
      return redirectWithSuccess(`/admin/event/${id}`, "Image removed");
    }),
  );

/** Create a handler that renders the event page with a specific attendee filter */
const eventPageHandler =
  (activeFilter?: AttendeeFilter): TypedRouteHandler<"GET /admin/event/:id"> =>
  (request, params) =>
    renderEventPage(request, params, activeFilter);

/** Handle GET /admin/event/:id */
const handleAdminEventGet = eventPageHandler();

/** Handle GET /admin/event/:id/in (checked-in filter) */
const handleAdminEventGetIn = eventPageHandler("in");

/** Handle GET /admin/event/:id/out (not-checked-in filter) */
const handleAdminEventGetOut = eventPageHandler("out");

/** Event routes */
export const eventsRoutes = defineRoutes({
  "GET /admin/event/new": handleNewEventGet,
  "POST /admin/event": handleCreateEvent,
  "GET /admin/event/:id/in": handleAdminEventGetIn,
  "GET /admin/event/:id/out": handleAdminEventGetOut,
  "GET /admin/event/:id": handleAdminEventGet,
  "GET /admin/event/:id/duplicate": handleAdminEventDuplicateGet,
  "GET /admin/event/:id/edit": handleAdminEventEditGet,
  "POST /admin/event/:id/edit": handleAdminEventEditPost,
  "GET /admin/event/:id/export": handleAdminEventExport,
  "GET /admin/event/:id/log": handleAdminEventLog,
  "POST /admin/event/:id/image/delete": handleImageDelete,
  "GET /admin/event/:id/deactivate": handleAdminEventDeactivateGet,
  "POST /admin/event/:id/deactivate": handleAdminEventDeactivatePost,
  "GET /admin/event/:id/reactivate": handleAdminEventReactivateGet,
  "POST /admin/event/:id/reactivate": handleAdminEventReactivatePost,
  "GET /admin/event/:id/delete": handleAdminEventDeleteGet,
  "POST /admin/event/:id/delete": handleAdminEventDelete,
  "DELETE /admin/event/:id/delete": handleAdminEventDelete,
});
