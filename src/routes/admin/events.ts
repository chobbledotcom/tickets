/**
 * Admin event management routes
 */

import { filter } from "#fp";
import { getAllowedDomain } from "#lib/config.ts";
import { toMinorUnits } from "#lib/currency.ts";
import { formatDateLabel, normalizeDatetime } from "#lib/dates.ts";
import {
  getEventWithActivityLog,
  logActivity,
} from "#lib/db/activityLog.ts";
import { ErrorCode, logError } from "#lib/logger.ts";
import { deleteAllStaleReservations } from "#lib/db/processed-payments.ts";
import {
  computeSlugIndex,
  deleteEvent,
  type EventInput,
  eventsTable,
  getEventWithCount,
  isSlugTaken,
} from "#lib/db/events.ts";
import { getAllGroups } from "#lib/db/groups.ts";
import { defineResource } from "#lib/rest/resource.ts";
import { generateSlug, normalizeSlug } from "#lib/slug.ts";
import type { AdminSession, Attendee, EventWithCount, Group } from "#lib/types.ts";
import type { EventEditFormValues, EventFormValues } from "#templates/fields.ts";
import { defineRoutes } from "#routes/router.ts";
import type { RouteParamsFor, TypedRouteHandler } from "#routes/router.ts";
import { csvResponse, getDateFilter, verifyIdentifier, withEventAttendeesAuth } from "#routes/admin/utils.ts";
import {
  formDataToParams,
  htmlResponse,
  notFoundResponse,
  redirect,
  requireSessionOr,
  withAuthForm,
  withAuthMultipartForm,
  withEventPage,
} from "#routes/utils.ts";
import { adminEventActivityLogPage } from "#templates/admin/activityLog.tsx";
import {
  adminDeactivateEventPage,
  adminDeleteEventPage,
  adminDuplicateEventPage,
  adminEventEditPage,
  adminEventPage,
  adminReactivateEventPage,
  type AddAttendeeMessage,
  type AttendeeFilter,
} from "#templates/admin/events.tsx";
import {
  deleteImage,
  type ImageValidationError,
  isStorageEnabled,
  uploadImage,
  validateImage,
} from "#lib/storage.ts";
import { generateAttendeesCsv } from "#templates/csv.ts";
import { eventFields, groupIdField, slugField } from "#templates/fields.ts";

/** Try to delete an image from CDN storage, logging errors on failure */
const tryDeleteImage = async (filename: string, eventId: number, detail: string): Promise<void> => {
  try {
    await deleteImage(filename);
  } catch {
    logError({ code: ErrorCode.STORAGE_DELETE, eventId, detail });
  }
};

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
const serializeBookableDays = (value: string): string | undefined =>
  value ? JSON.stringify(value.split(",").map((d) => d.trim()).filter((d) => d)) : undefined;

/** Extract common event fields from validated form values, normalizing datetimes to UTC */
const extractCommonFields = (values: EventFormValues) => {
  const rawDate = values.date ?? "";
  return {
    name: values.name,
    description: values.description,
    date: rawDate ? normalizeDatetime(rawDate, "date") : rawDate,
    location: values.location,
    groupId: Number(values.group_id) || 0,
    maxAttendees: values.max_attendees,
    thankYouUrl: values.thank_you_url || null,
    unitPrice: values.unit_price ? toMinorUnits(Number.parseFloat(values.unit_price)) : null,
    maxQuantity: values.max_quantity,
    webhookUrl: values.webhook_url || null,
    fields: values.fields || "email",
    closesAt: values.closes_at ? normalizeDatetime(values.closes_at, "closes_at") : values.closes_at,
    eventType: values.event_type || undefined,
    bookableDays: serializeBookableDays(values.bookable_days),
    minimumDaysBefore: values.minimum_days_before ?? 1,
    maximumDaysAfter: values.maximum_days_after ?? 90,
  };
};

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
  fields: [...eventFields, groupIdField],
  toInput: extractEventInput,
  nameField: "name",
});

/** User-facing messages for image validation errors */
const IMAGE_ERROR_MESSAGES: Record<ImageValidationError, string> = {
  too_large: "Image exceeds the 256KB size limit",
  invalid_type: "Image must be a JPEG, PNG, GIF, or WebP file",
  invalid_content: "File does not appear to be a valid image",
};

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
  await logActivity(`Image uploaded for event`, eventId);
  return null;
};

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
const handleCreateEvent = (request: Request): Promise<Response> =>
  withAuthMultipartForm(request, async (_session, formData) => {
    const form = formDataToParams(formData);
    const result = await eventsResource.create(form);
    if (!result.ok) return redirect("/admin");
    await logActivity(`Event '${result.row.name}' created`, result.row);
    const imageError = await processFormImage(formData, result.row.id);
    if (imageError) {
      return redirect(`/admin?image_error=${encodeURIComponent(imageError)}`);
    }
    return redirect("/admin");
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

/** Render event page with attendee list and optional filter */
const renderEventPage = async (request: Request, { id }: { id: number }, activeFilter: AttendeeFilter = "all") => {
  await deleteAllStaleReservations();
  return withEventAttendees(request, id, ({ event, attendees, session }) => {
    const dateFilter = event.event_type === "daily" ? getDateFilter(request) : null;
    const availableDates = event.event_type === "daily" ? getUniqueDates(attendees) : [];
    const filteredByDate = filterByDate(attendees, dateFilter);
    const imageError = new URL(request.url).searchParams.get("image_error");
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
      }),
    );
  });
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
): Response =>
  htmlResponse(renderPage(event, session, error), 400);

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

type AdminEventIdParams = RouteParamsFor<"GET /admin/event/:id">;

const withEventAndGroupsPage =
  (
    renderPage: (event: EventWithCount, groups: Group[], session: AdminSession) => string,
  ) =>
  (request: Request, params: AdminEventIdParams): Promise<Response> =>
    requireSessionOr(request, async (session) => {
      const ctx = await getEventAndGroups(params.id);
      return ctx
        ? htmlResponse(renderPage(ctx.event, ctx.groups, session))
        : notFoundResponse();
    });

const handleAdminEventDuplicateGet: TypedRouteHandler<"GET /admin/event/:id/duplicate"> = withEventAndGroupsPage(
  adminDuplicateEventPage,
);

/** Handle GET /admin/event/:id/edit */
const handleAdminEventEditGet: TypedRouteHandler<"GET /admin/event/:id/edit"> = withEventAndGroupsPage(
  adminEventEditPage,
);

/** Handle POST /admin/event/:id/edit */
const handleAdminEventEditPost = (
  request: Request,
  { id }: { id: number },
): Promise<Response> =>
  withAuthMultipartForm(request, async (session, formData) => {
    const existing = await getEventWithCount(id);
    if (!existing) return notFoundResponse();

    const form = formDataToParams(formData);

    // Build a resource that includes the slug field and validates uniqueness
    const updateResource = defineResource({
      table: eventsTable,
      fields: [...eventFields, slugField, groupIdField],
      toInput: extractEventUpdateInput,
      nameField: "name",
      validate: async (input, existingId) => {
        const taken = await isSlugTaken(input.slug, Number(existingId));
        return taken ? "Slug is already in use by another event" : null;
      },
    });

    const result = await updateResource.update(id, form);
    if (result.ok) {
      await logActivity(`Event '${result.row.name}' updated`, result.row);
      const imageError = await processFormImage(formData, id, existing.image_url);
      const imageErrorParam = imageError ? `?image_error=${encodeURIComponent(imageError)}` : "";
      return redirect(`/admin/event/${result.row.id}${imageErrorParam}`);
    }
    if ("notFound" in result) return notFoundResponse();

    const ctx = await getEventAndGroups(id);
    return ctx
      ? htmlResponse(adminEventEditPage(ctx.event, ctx.groups, session, result.error), 400)
      : notFoundResponse();
  });

/**
 * Handle GET /admin/event/:id/export (CSV export)
 */
const handleAdminEventExport = (request: Request, { id }: { id: number }) =>
  withEventAttendees(request, id, async ({ event, attendees }) => {
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
  id: number,
  renderPage: (event: EventWithCount, session: AdminSession, error?: string) => string,
  errorMsg: string,
  action: (event: EventWithCount) => Promise<Response>,
): Promise<Response> =>
  withAuthForm(request, async (session, form) => {
    const event = await getEventWithCount(id);
    if (!event) {
      return notFoundResponse();
    }

    const confirmIdentifier = form.get("confirm_identifier") ?? "";
    if (!verifyIdentifier(event.name, confirmIdentifier)) {
      return eventErrorPage(event, renderPage, session, errorMsg);
    }

    return action(event);
  });

const CONFIRM_NAME_MSG = "Event name does not match. Please type the exact name to confirm.";

/** Factory for event toggle handlers (deactivate/reactivate) */
const eventToggleHandler = (
  renderPage: typeof adminDeactivateEventPage,
  active: number,
  verb: string,
) => (request: Request, { id }: { id: number }): Promise<Response> =>
  handleEventWithConfirmation(request, id, renderPage, CONFIRM_NAME_MSG, async (event) => {
    await eventsTable.update(id, { active });
    await logActivity(`Event '${event.name}' ${verb}`, id);
    return redirect(`/admin/event/${id}`);
  });

/** Handle POST /admin/event/:id/deactivate */
const handleAdminEventDeactivatePost = eventToggleHandler(adminDeactivateEventPage, 0, "deactivated");

/** Handle POST /admin/event/:id/reactivate */
const handleAdminEventReactivatePost = eventToggleHandler(adminReactivateEventPage, 1, "reactivated");

/** Handle GET /admin/event/:id/delete (show confirmation page) */
const handleAdminEventDeleteGet = withEventPage(adminDeleteEventPage);

/**
 * Handle GET /admin/event/:id/log
 * Uses batched query to fetch event + activity log in a single DB round-trip.
 */
const handleAdminEventLog = (
  request: Request,
  { id }: { id: number },
): Promise<Response> =>
  requireSessionOr(request, async (session) => {
    const result = await getEventWithActivityLog(id);
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
  { id }: { id: number },
): Promise<Response> =>
  needsVerify(request)
    ? handleEventWithConfirmation(
        request, id, adminDeleteEventPage,
        "Event name does not match. Please type the exact name to confirm deletion.",
        performDelete,
      )
    : withAuthForm(request, async () => {
        const event = await getEventWithCount(id);
        return event ? performDelete(event) : notFoundResponse();
      });

/** Handle POST /admin/event/:id/image/delete (delete event image) */
const handleImageDelete = (
  request: Request,
  { id }: { id: number },
): Promise<Response> =>
  withAuthForm(request, async () => {
    const event = await getEventWithCount(id);
    if (!event) return notFoundResponse();

    if (event.image_url) {
      await tryDeleteImage(event.image_url, event.id, "image removal");
      await eventsTable.update(id, { imageUrl: "" });
      await logActivity(`Image removed for '${event.name}'`, event);
    }

    return redirect(`/admin/event/${id}`);
  });

/** Handle GET /admin/event/:id */
const handleAdminEventGet = (request: Request, params: { id: number }) =>
  renderEventPage(request, params);

/** Handle GET /admin/event/:id/in (checked-in filter) */
const handleAdminEventGetIn = (request: Request, params: { id: number }) =>
  renderEventPage(request, params, "in");

/** Handle GET /admin/event/:id/out (not-checked-in filter) */
const handleAdminEventGetOut = (request: Request, params: { id: number }) =>
  renderEventPage(request, params, "out");

/** Event routes */
export const eventsRoutes = defineRoutes({
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
