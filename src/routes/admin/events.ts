/**
 * Admin event management routes
 */

import { compact, filter, map, pipe, sort, unique } from "#fp";
import { getEffectiveDomain } from "#lib/config.ts";
import { toMinorUnits } from "#lib/currency.ts";
import { formatDateLabel, normalizeDatetime } from "#lib/dates.ts";
import { getEventWithActivityLog, logActivity } from "#lib/db/activityLog.ts";
import {
  computeSlugIndex,
  type EventInput,
  eventsTable,
  getEventWithCount,
} from "#lib/db/events.ts";
import { getAllGroups } from "#lib/db/groups.ts";
import { deleteAllStaleReservations } from "#lib/db/processed-payments.ts";
import {
  getAttendeeAnswersBatch,
  getQuestionsForEvent,
} from "#lib/db/questions.ts";
import { settings } from "#lib/db/settings.ts";
import {
  applyDemoOverrides,
  EVENT_DEMO_FIELDS,
  isDemoMode,
} from "#lib/demo.ts";
import {
  generateUniqueEventSlug,
  performEventDelete,
  validateEventInput,
} from "#lib/events-actions.ts";
import { getFlash } from "#lib/flash-context.ts";
import { ErrorCode, logDebug, logError } from "#lib/logger.ts";
import { defineResource } from "#lib/rest/resource.ts";
import { normalizeSlug } from "#lib/slug.ts";
import {
  ATTACHMENT_ERROR_MESSAGES,
  deleteFile,
  generateAttachmentFilename,
  IMAGE_ERROR_MESSAGES,
  isStorageEnabled,
  tryDeleteFile,
  uploadAttachment,
  uploadImage,
  validateAttachment,
  validateImage,
} from "#lib/storage.ts";
import type {
  AdminSession,
  Attendee,
  EventWithCount,
  Group,
} from "#lib/types.ts";
import { isBuilderEnabled } from "#routes/admin/builder.ts";
import { createConfirmedHandlers, csvResponse, eventAttendeesLoader, getDateFilter } from "#routes/admin/utils.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  AUTH_FORM, AUTH_MULTIPART, authenticatedGetById, formDataToParams, getSearchParam,
  htmlResponse, notFoundResponse, redirect, requireSessionOr, withAuth,
} from "#routes/utils.ts";
import { adminEventActivityLogPage } from "#templates/admin/activityLog.tsx";
import {
  type AttendeeFilter,
  adminDeactivateEventPage,
  adminDeleteEventPage,
  adminDuplicateEventPage,
  adminEventEditPage,
  adminEventNewPage,
  adminEventPage,
  adminReactivateEventPage,
} from "#templates/admin/events.tsx";
import { type CsvQuestionData, generateAttendeesCsv } from "#templates/csv.ts";
import type {
  EventEditFormValues,
  EventFormValues,
} from "#templates/fields.ts";
import {
  assignBuiltSiteField,
  eventFields,
  groupIdField,
  slugField,
  splitCsv,
} from "#templates/fields.ts";
import { withEntityFromParam } from "./utils.ts";

/** Parse comma-separated day names to string array */
const parseBookableDays = (value: string): string[] | undefined =>
  value ? splitCsv(value) : undefined;

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
    assignBuiltSite: isBuilderEnabled() && values.assign_built_site === "1",
    bookableDays: parseBookableDays(values.bookable_days),
    canPayMore: values.can_pay_more === "1",
    closesAt,
    date,
    description: values.description,
    eventType: values.event_type || "standard",
    fields: values.fields || "",
    groupId: Number(values.group_id) || 0,
    hidden: values.hidden === "1",
    location: values.location,
    maxAttendees: values.max_attendees,
    maximumDaysAfter: values.maximum_days_after ?? 90,
    maxPrice: toMinorUnits(Number.parseFloat(values.max_price)),
    maxQuantity: values.max_quantity,
    minimumDaysBefore: values.minimum_days_before ?? 1,
    name: values.name,
    nonTransferable: values.non_transferable === "1",
    purchaseOnly: values.purchase_only === "1",
    thankYouUrl: values.thank_you_url || "",
    unitPrice,
    webhookUrl,
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

/** Events resource for REST create operations */
const eventsResource = defineResource({
  fields: [...eventFields, assignBuiltSiteField, groupIdField],
  nameField: "name",
  table: eventsTable,
  toInput: extractEventInput,
  validate: validateEventInput,
});

/** Generic form file processor: extract, validate, replace old, upload, update event */
const processFormFile = async (opts: {
  formData: FormData;
  fieldName: string;
  eventId: number;
  existingUrl?: string;
  validate: (data: Uint8Array, file: File) => string | null;
  upload: (data: Uint8Array, file: File) => Promise<Partial<EventInput>>;
  label: string;
}): Promise<string | null> => {
  if (!isStorageEnabled()) return null;
  const entry = opts.formData.get(opts.fieldName);
  if (!(entry instanceof File) || entry.size === 0) {
    if (entry !== null && !(entry instanceof File)) {
      logDebug(
        "Storage",
        `${opts.label} field "${opts.fieldName}" is ${typeof entry}, not File`,
      );
    }
    return null;
  }

  const data = new Uint8Array(await entry.arrayBuffer());
  const error = opts.validate(data, entry);
  if (error) return error;

  if (opts.existingUrl) {
    await tryDeleteFile(
      opts.existingUrl,
      opts.eventId,
      `old ${opts.label} cleanup`,
    );
  }

  const [uploadResult] = await Promise.allSettled([opts.upload(data, entry)]);
  if (uploadResult.status === "fulfilled") {
    await eventsTable.update(opts.eventId, uploadResult.value);
    await logActivity(`${opts.label} uploaded for event`, opts.eventId);
    return null;
  }
  const detail = `${opts.label} upload failed: ${String(uploadResult.reason)}`;
  logError({ code: ErrorCode.STORAGE_UPLOAD, detail, eventId: opts.eventId });
  return detail;
};

/** Process image from multipart form and attach to event. Returns error message if validation fails. */
const processFormImage = (
  formData: FormData,
  eventId: number,
  existingImageUrl?: string,
): Promise<string | null> =>
  processFormFile({
    eventId,
    existingUrl: existingImageUrl,
    fieldName: "image",
    formData,
    label: "Image",
    upload: async (data, file) => {
      const v = validateImage(data, file.type) as {
        valid: true;
        detectedType: string;
      };
      const imageUrl = await uploadImage(data, v.detectedType);
      return { imageUrl };
    },
    validate: (data, file) => {
      const v = validateImage(data, file.type);
      return v.valid ? null : IMAGE_ERROR_MESSAGES[v.error];
    },
  });

/** Process attachment from multipart form and attach to event. Returns error message if validation fails. */
const processFormAttachment = (
  formData: FormData,
  eventId: number,
  existingAttachmentUrl?: string,
): Promise<string | null> =>
  processFormFile({
    eventId,
    existingUrl: existingAttachmentUrl,
    fieldName: "attachment",
    formData,
    label: "Attachment",
    upload: async (data, file) => {
      const filename = generateAttachmentFilename(file.name);
      await uploadAttachment(data, filename);
      return { attachmentName: file.name, attachmentUrl: filename };
    },
    validate: (data) => {
      const v = validateAttachment(data);
      return v.valid ? null : ATTACHMENT_ERROR_MESSAGES[v.error];
    },
  });

/** Process image + attachment uploads and redirect, reporting any upload errors */
const processUploadsAndRedirect = async (
  formData: FormData,
  eventId: number,
  redirectUrl: string,
  successMessage: string,
  existingImageUrl?: string,
  existingAttachmentUrl?: string,
): Promise<Response> => {
  const imageError = await processFormImage(
    formData,
    eventId,
    existingImageUrl,
  );
  const attachmentError = await processFormAttachment(
    formData,
    eventId,
    existingAttachmentUrl,
  );
  const errors = compact([imageError, attachmentError]);
  if (errors.length > 0) {
    return redirect(
      redirectUrl,
      `${successMessage} but: ${errors.join("; ")}`,
      false,
    );
  }
  return redirect(redirectUrl, successMessage, true);
};

/** Handle event with attendees - auth, fetch, then apply handler fn */
const eventAttendeesHandler =
  (handler: (ctx: {
    event: EventWithCount;
    attendees: Attendee[];
    session: AdminSession;
  }) => Response | Promise<Response>) =
  (event: EventWithCount, attendees: Attendee[], session: AdminSession) =>
    handler({ attendees, event, session });

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
  withAuth(request, AUTH_MULTIPART, async (session, formData) => {
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
    return processUploadsAndRedirect(
      formData,
      result.row.id,
      "/admin",
      "Event created",
    );
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

/** Filter attendees by date for daily events */
const filterByDate = (
  attendees: Attendee[],
  date: string | null,
): Attendee[] =>
  date ? filter((a: Attendee) => a.date === date)(attendees) : attendees;

/** Collect unique dates from attendees, sorted ascending */
const getUniqueDates: (
  attendees: Attendee[],
) => { value: string; label: string }[] = pipe(
  map((a: Attendee) => a.date),
  (dates: (string | null)[]) => compact(dates),
  (dates: string[]) => unique(dates),
  sort((a: string, b: string) => a.localeCompare(b)),
  map((d: string) => ({ label: formatDateLabel(d), value: d })),
);

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
    availableDates,
    dateFilter,
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
    eventAttendeesLoader(request, id)(
      eventAttendeesHandler(async ({ event, attendees, session }) => {
      const { dateFilter, availableDates, filteredByDate } = applyDateFilter(
        event,
        attendees,
        request,
      );
      const attendeeIds = filteredByDate.map((a) => a.id);
      const [flash, phonePrefix, questions, attendeeAnswerMap] =
        await Promise.all([
          Promise.resolve(getFlash()),
          Promise.resolve(settings.phonePrefix),
          getQuestionsForEvent(event.id),
          getAttendeeAnswersBatch(attendeeIds),
        ]);
      const questionData =
        questions.length > 0 ? { attendeeAnswerMap, questions } : undefined;
      return htmlResponse(
        adminEventPage({
          activeFilter,
          allowedDomain: getEffectiveDomain(),
          attendees: filteredByDate,
          availableDates,
          checkinMessage: getCheckinMessage(request),
          dateFilter,
          errorMessage: flash.error,
          event,
          phonePrefix,
          questionData,
          session,
          successMessage: flash.success,
        }),
      );
    }),
  ]);
  return response;
};

/** Redirect to action page with error flash */
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
      withEntityFromParam(params.id, getEventAndGroups, (ctx) =>
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
  withAuth(request, AUTH_MULTIPART, (session, formData) =>
    withEntityFromParam(id, getEventWithCount, async (existing) => {
      const form = formDataToParams(formData);
      applyDemoOverrides(form, EVENT_DEMO_FIELDS);

      // Build a resource that includes the slug field; uniqueness is enforced
      // by validateEventInput when existingId is set.
      const updateResource = defineResource({
        fields: [...eventFields, assignBuiltSiteField, slugField, groupIdField],
        nameField: "name",
        table: eventsTable,
        toInput: extractEventUpdateInput,
        validate: validateEventInput,
      });

      const result = await updateResource.update(id, form);
      if (result.ok) {
        await logActivity(`Event '${result.row.name}' updated`, result.row);
        return processUploadsAndRedirect(
          formData,
          id,
          `/admin/event/${result.row.id}`,
          "Event updated",
          existing.image_url,
          existing.attachment_url,
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
    }),
  );

/**
 * Handle GET /admin/event/:id/export (CSV export)
 */
const handleAdminEventExport: TypedRouteHandler<
  "GET /admin/event/:id/export"
> = (request, { id }) =>
  eventAttendeesLoader(request, id)(
    eventAttendeesHandler(async ({ event, attendees }) => {
    const { dateFilter, filteredByDate } = applyDateFilter(
      event,
      attendees,
      request,
    );
    const isDaily = event.event_type === "daily";

    // Load questions and attendee answers for CSV
    const attendeeIds = filteredByDate.map((a) => a.id);
    const [questions, attendeeAnswerMap] = await Promise.all([
      getQuestionsForEvent(event.id),
      getAttendeeAnswersBatch(attendeeIds),
    ]);
    const questionData: CsvQuestionData | undefined =
      questions.length > 0 ? { attendeeAnswerMap, questions } : undefined;

    const csv = generateAttendeesCsv(
      filteredByDate,
      isDaily,
      {
        eventDate: event.date,
        eventLocation: event.location,
      },
      questionData,
    );
    const sanitizedName = event.name.replace(/[^a-zA-Z0-9]/g, "_");
    const filename = dateFilter
      ? `${sanitizedName}_${dateFilter}_attendees.csv`
      : `${sanitizedName}_attendees.csv`;
    await logActivity(
      `CSV exported for '${event.name}'${
        dateFilter ? ` (date: ${dateFilter})` : ""
      }`,
      event,
    );
    return csvResponse(csv, filename);
  });

/** Shared config for event confirmation handlers */
const eventConfirmBase = {
  auth: "any" as const,
  identifier: (event: EventWithCount) => event.name,
  identifierLabel: "Event name",
  load: (_id: number) => getEventWithCount(_id),
};

/** Factory for event toggle handlers (deactivate/reactivate) */
const eventToggleHandlers = (opts: {
  active: boolean;
  action: string;
  renderPage: (
    event: EventWithCount,
    session: { readonly adminLevel: "owner" | "manager" },
    error?: string,
  ) => string;
}) =>
  createConfirmedHandlers<EventWithCount>({
    ...eventConfirmBase,
    actionLabel: `${opts.action}ion`,
    onConfirm: async (event, id) => {
      await eventsTable.update(id, { active: opts.active });
      await logActivity(`Event '${event.name}' ${opts.action}d`, id);
    },
    path: `/admin/event/:id/${opts.action}`,
    render: opts.renderPage,
    successMessage: `Event ${opts.action}d`,
    successRedirect: (_, id) => `/admin/event/${id}`,
  });

const eventDeactivate = eventToggleHandlers({
  action: "deactivate",
  active: false,
  renderPage: adminDeactivateEventPage,
});

const eventReactivate = eventToggleHandlers({
  action: "reactivate",
  active: true,
  renderPage: adminReactivateEventPage,
});

/** Confirmed-delete handlers for events */
const eventDelete = createConfirmedHandlers<EventWithCount>({
  ...eventConfirmBase,
  onConfirm: async (event) => {
    await performEventDelete(event);
  },
  path: "/admin/event/:id/delete",
  render: (event, session, error) =>
    adminDeleteEventPage(event, session, error),
  successMessage: "Event deleted",
  successRedirect: "/admin",
});

/**
 * Handle GET /admin/event/:id/log
 * Uses batched query to fetch event + activity log in a single DB round-trip.
 */
const handleAdminEventLog = authenticatedGetById(null)(
  getEventWithActivityLog,
  (result, session) =>
    htmlResponse(
      adminEventActivityLogPage(result.event, result.entries, session),
    ),
);

/** Handle DELETE /admin/event/:id (delete event with logging) */
const handleAdminEventDelete: TypedRouteHandler<
  "POST /admin/event/:id/delete"
> = (request, { id }) =>
  getSearchParam(request, "verify_identifier") !== "false"
    ? eventDelete.post(request, id)
    : withAuth(request, AUTH_FORM, () =>
        withEntityFromParam(id, getEventWithCount, async (event) => {
          await performEventDelete(event);
          return redirect("/admin", "Event deleted", true);
        }),
      );

/** Generic handler for deleting an event's uploaded file (image or attachment) */
const handleFileDelete =
  (
    label: string,
    getUrl: (e: EventWithCount) => string,
    clearFields: Partial<EventInput>,
  ): TypedRouteHandler<`POST /admin/event/:id/${string}/delete`> =>
  (request, { id }) =>
    withAuth(request, AUTH_FORM, () =>
      withEntityFromParam(id, getEventWithCount, async (event) => {
        const url = getUrl(event);
        if (url) {
          const [deleteResult] = await Promise.allSettled([deleteFile(url)]);
          if (deleteResult.status === "fulfilled") {
            await eventsTable.update(id, clearFields);
            await logActivity(`${label} removed for '${event.name}'`, event);
            return redirect(`/admin/event/${id}`, `${label} removed`, true);
          }
          const detail = `${label} removal failed: ${String(
            deleteResult.reason,
          )}`;
          logError({
            code: ErrorCode.STORAGE_DELETE,
            detail,
            eventId: event.id,
          });
          return redirect(
            `/admin/event/${id}`,
            `${label} removal failed`,
            false,
          );
        }
        return redirect(`/admin/event/${id}`, `${label} removed`, true);
      }),
    );

/** Handle POST /admin/event/:id/image/delete (delete event image) */
const handleImageDelete = handleFileDelete("Image", (e) => e.image_url, {
  imageUrl: "",
});

/** Handle POST /admin/event/:id/attachment/delete (delete event attachment) */
const handleAttachmentDelete = handleFileDelete(
  "Attachment",
  (e) => e.attachment_url,
  { attachmentName: "", attachmentUrl: "" },
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
export const eventsRoutes = {
  ...eventDeactivate.routes,
  ...eventReactivate.routes,
  ...eventDelete.routes,
  ...defineRoutes({
    "DELETE /admin/event/:id/delete": handleAdminEventDelete,
    "GET /admin/event/:id": handleAdminEventGet,
    "GET /admin/event/:id/duplicate": handleAdminEventDuplicateGet,
    "GET /admin/event/:id/edit": handleAdminEventEditGet,
    "GET /admin/event/:id/export": handleAdminEventExport,
    "GET /admin/event/:id/in": handleAdminEventGetIn,
    "GET /admin/event/:id/log": handleAdminEventLog,
    "GET /admin/event/:id/out": handleAdminEventGetOut,
    "GET /admin/event/new": handleNewEventGet,
    "POST /admin/event": handleCreateEvent,
    "POST /admin/event/:id/attachment/delete": handleAttachmentDelete,
    "POST /admin/event/:id/delete": handleAdminEventDelete,
    "POST /admin/event/:id/edit": handleAdminEventEditPost,
    "POST /admin/event/:id/image/delete": handleImageDelete,
  }),
};
