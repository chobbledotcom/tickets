/**
 * Admin listing management routes
 */

import { compact, filter, map, pipe, sort, unique } from "#fp";
import {
  csvResponse,
  getDateFilter,
  listingAttendeesLoader,
} from "#routes/admin/actions.ts";
import { isBuilderEnabled } from "#routes/admin/builder.ts";
import { createConfirmedHandlers } from "#routes/admin/confirmation.ts";
import {
  AUTH_FORM,
  AUTH_MULTIPART,
  requireSessionOr,
  withAuth,
} from "#routes/auth.ts";
import { formDataToParams } from "#routes/csrf.ts";
import { authenticatedGetById } from "#routes/entity.ts";
import { htmlResponse, notFoundResponse, redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { defineRoutes } from "#routes/router.ts";
import { getSearchParam } from "#routes/url.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { toMinorUnits } from "#shared/currency.ts";
import { formatDateLabel, normalizeDatetime } from "#shared/dates.ts";
import {
  getListingWithActivityLog,
  logActivity,
} from "#shared/db/activityLog.ts";
import { getGroupRemainingByGroupId } from "#shared/db/attendees/capacity.ts";
import {
  checkGroupCapAfterDurationChange,
  recomputeListingBookingRanges,
} from "#shared/db/attendees.ts";
import { getAllGroups, groupsTable } from "#shared/db/groups.ts";
import {
  computeSlugIndex,
  getListingWithCount,
  type ListingInput,
  listingsTable,
} from "#shared/db/listings.ts";
import { deleteAllStaleReservations } from "#shared/db/processed-payments.ts";
import {
  getAttendeeAnswersBatch,
  getQuestionsForListing,
} from "#shared/db/questions.ts";
import { settings } from "#shared/db/settings.ts";
import {
  applyDemoOverrides,
  isDemoMode,
  LISTING_DEMO_FIELDS,
} from "#shared/demo.ts";
import { getFlash } from "#shared/flash-context.ts";
import {
  generateUniqueListingSlug,
  performListingDelete,
  validateListingInput,
} from "#shared/listings-actions.ts";
import { ErrorCode, logDebug, logError } from "#shared/logger.ts";
import { defineResource } from "#shared/rest/resource.ts";
import { normalizeSlug } from "#shared/slug.ts";
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
} from "#shared/storage.ts";
import type {
  AdminSession,
  Attendee,
  Group,
  ListingWithCount,
} from "#shared/types.ts";
import { adminListingActivityLogPage } from "#templates/admin/activityLog.tsx";
import {
  type AttendeeFilter,
  adminDeactivateListingPage,
  adminDeleteListingPage,
  adminDuplicateListingPage,
  adminListingEditPage,
  adminListingNewPage,
  adminListingPage,
  adminReactivateListingPage,
  type GroupContext,
} from "#templates/admin/listings.tsx";
import { type CsvQuestionData, generateAttendeesCsv } from "#templates/csv.ts";
import type {
  ListingEditFormValues,
  ListingFormValues,
} from "#templates/fields.ts";
import {
  assignBuiltSiteField,
  groupIdField,
  initialSiteMonthsField,
  listingFields,
  monthsPerUnitField,
  slugField,
  splitCsv,
} from "#templates/fields.ts";
import { withEntityFromParam } from "./entity-handlers.ts";

/** Parse comma-separated day names to string array */
const parseBookableDays = (value: string): string[] | undefined =>
  value ? splitCsv(value) : undefined;

/** Extract common listing fields from validated form values, normalizing datetimes to UTC */
const extractCommonFields = (values: ListingFormValues) => {
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
    durationDays: values.duration_days ?? 1,
    fields: values.fields || "",
    groupId: Number(values.group_id) || 0,
    hidden: values.hidden === "1",
    initialSiteMonths: Number(values.initial_site_months) || 0,
    listingType: values.listing_type || "standard",
    location: values.location,
    maxAttendees: values.max_attendees,
    maximumDaysAfter: values.maximum_days_after ?? 90,
    maxPrice: toMinorUnits(Number.parseFloat(values.max_price)),
    maxQuantity: values.max_quantity,
    minimumDaysBefore: values.minimum_days_before ?? 1,
    monthsPerUnit: Number(values.months_per_unit) || 0,
    name: values.name,
    nonTransferable: values.non_transferable === "1",
    purchaseOnly: values.purchase_only === "1",
    thankYouUrl: values.thank_you_url || "",
    unitPrice,
    webhookUrl,
  };
};

/** Extract listing input from validated form (async to compute slugIndex) */
const extractListingInput = async (
  values: ListingFormValues,
): Promise<ListingInput> => {
  const { slug, slugIndex } = await generateUniqueListingSlug();
  return { ...extractCommonFields(values), slug, slugIndex };
};

/** Extract listing input for update (reads slug from form, normalizes it) */
const extractListingUpdateInput = async (
  values: ListingEditFormValues,
): Promise<ListingInput> => {
  const slug = normalizeSlug(values.slug);
  const slugIndex = await computeSlugIndex(slug);
  return { ...extractCommonFields(values), slug, slugIndex };
};

/** Listings resource for REST create operations */
const listingsResource = defineResource({
  fields: [
    ...listingFields,
    monthsPerUnitField,
    initialSiteMonthsField,
    assignBuiltSiteField,
    groupIdField,
  ],
  nameField: "name",
  table: listingsTable,
  toInput: extractListingInput,
  validate: validateListingInput,
});

/** Generic form file processor: extract, validate, replace old, upload, update listing */
const processFormFile = async (opts: {
  formData: FormData;
  fieldName: string;
  listingId: number;
  existingUrl?: string;
  validate: (data: Uint8Array, file: File) => string | null;
  upload: (data: Uint8Array, file: File) => Promise<Partial<ListingInput>>;
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
      opts.listingId,
      `old ${opts.label} cleanup`,
    );
  }

  const [uploadResult] = await Promise.allSettled([opts.upload(data, entry)]);
  if (uploadResult.status === "fulfilled") {
    await listingsTable.update(opts.listingId, uploadResult.value);
    await logActivity(`${opts.label} uploaded for listing`, opts.listingId);
    return null;
  }
  const detail = `${opts.label} upload failed: ${String(uploadResult.reason)}`;
  logError({
    code: ErrorCode.STORAGE_UPLOAD,
    detail,
    listingId: opts.listingId,
  });
  return detail;
};

/** Process image from multipart form and attach to listing. Returns error message if validation fails. */
const processFormImage = (
  formData: FormData,
  listingId: number,
  existingImageUrl?: string,
): Promise<string | null> =>
  processFormFile({
    existingUrl: existingImageUrl,
    fieldName: "image",
    formData,
    label: "Image",
    listingId,
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

/** Process attachment from multipart form and attach to listing. Returns error message if validation fails. */
const processFormAttachment = (
  formData: FormData,
  listingId: number,
  existingAttachmentUrl?: string,
): Promise<string | null> =>
  processFormFile({
    existingUrl: existingAttachmentUrl,
    fieldName: "attachment",
    formData,
    label: "Attachment",
    listingId,
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
  listingId: number,
  redirectUrl: string,
  successMessage: string,
  existingImageUrl?: string,
  existingAttachmentUrl?: string,
): Promise<Response> => {
  const imageError = await processFormImage(
    formData,
    listingId,
    existingImageUrl,
  );
  const attachmentError = await processFormAttachment(
    formData,
    listingId,
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

/** Handle listing with attendees - auth, fetch, then apply handler fn */
const listingAttendeesHandler =
  (
    _handler: (ctx: {
      listing: ListingWithCount;
      attendees: Attendee[];
      session: AdminSession;
    }) => Response | Promise<Response>,
  ) =>
  (listing: ListingWithCount, attendees: Attendee[], session: AdminSession) =>
    _handler({ attendees, listing, session });

/**
 * Handle GET /admin/listing/new (show create listing form)
 */
const handleNewListingGet: TypedRouteHandler<"GET /admin/listing/new"> = (
  request,
) =>
  requireSessionOr(request, async (session) => {
    const groups = await getAllGroups();
    return htmlResponse(adminListingNewPage(groups, session));
  });

/**
 * Handle POST /admin/listing (create listing)
 */
const handleCreateListing: TypedRouteHandler<"POST /admin/listing"> = (
  request,
) =>
  withAuth(request, AUTH_MULTIPART, async (session, formData) => {
    const form = formDataToParams(formData);
    applyDemoOverrides(form, LISTING_DEMO_FIELDS);
    const result = await listingsResource.create(form);
    if (!result.ok) {
      const groups = await getAllGroups();
      return htmlResponse(
        adminListingNewPage(groups, session, result.error),
        400,
      );
    }
    await logActivity(`Listing '${result.row.name}' created`, result.row);
    return processUploadsAndRedirect(
      formData,
      result.row.id,
      "/admin",
      "Listing created",
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

/** Filter attendees by date for daily listings */
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

/** Get date filter and filtered attendees for daily listings */
const applyDateFilter = (
  listing: ListingWithCount,
  attendees: Attendee[],
  request: Request,
) => {
  const dateFilter =
    listing.listing_type === "daily" ? getDateFilter(request) : null;
  const availableDates =
    listing.listing_type === "daily" ? getUniqueDates(attendees) : [];
  return {
    availableDates,
    dateFilter,
    filteredByDate: filterByDate(attendees, dateFilter),
  };
};

/** Fetch group + current usage when the listing sits in a capped group, so the
 * detail page can render a row for the shared cap. Returns undefined for
 * ungrouped or uncapped groups. */
const loadGroupContext = async (
  listing: ListingWithCount,
  dateFilter: string | null,
): Promise<GroupContext | undefined> => {
  if (listing.group_id === 0) return undefined;
  const group = await groupsTable.findById(listing.group_id);
  if (!group || group.max_attendees <= 0) return undefined;
  const remainingMap = await getGroupRemainingByGroupId([group.id], dateFilter);
  // group.max_attendees > 0 guarantees the helper returns an entry for it.
  const remaining = remainingMap.get(group.id) as number;
  return { attendeeCount: group.max_attendees - remaining, group };
};

/** Render listing page with attendee list and optional filter */
const renderListingPage = async (
  request: Request,
  { id }: { id: number },
  activeFilter: AttendeeFilter = "all",
) => {
  // Run stale reservation cleanup concurrently with listing data loading.
  // These are independent: cleanup targets processed_payments with NULL attendee_id,
  // which doesn't affect the attendees query. Saves 1 HTTP round-trip.
  const [, response] = await Promise.all([
    deleteAllStaleReservations(),
    listingAttendeesLoader(
      request,
      id,
    )(
      listingAttendeesHandler(async ({ listing, attendees, session }) => {
        const { dateFilter, availableDates, filteredByDate } = applyDateFilter(
          listing,
          attendees,
          request,
        );
        const attendeeIds = filteredByDate.map((a) => a.id);
        const [flash, phonePrefix, questions, attendeeAnswerMap, groupContext] =
          await Promise.all([
            Promise.resolve(getFlash()),
            Promise.resolve(settings.phonePrefix),
            getQuestionsForListing(listing.id),
            getAttendeeAnswersBatch(attendeeIds),
            loadGroupContext(listing, dateFilter),
          ]);
        const questionData =
          questions.length > 0 ? { attendeeAnswerMap, questions } : undefined;
        return htmlResponse(
          adminListingPage({
            activeFilter,
            allowedDomain: getEffectiveDomain(),
            attendees: filteredByDate,
            availableDates,
            checkinMessage: getCheckinMessage(request),
            dateFilter,
            errorMessage: flash.error,
            groupContext,
            listing,
            phonePrefix,
            questionData,
            session,
            successMessage: flash.success,
          }),
        );
      }),
    ),
  ]);
  return response;
};

/** Redirect to action page with error flash */
/** Handle GET /admin/listing/:id/duplicate */
const getListingAndGroups = async (
  listingId: number,
): Promise<{ listing: ListingWithCount; groups: Group[] } | null> => {
  const [listing, groups] = await Promise.all([
    getListingWithCount(listingId),
    getAllGroups(),
  ]);
  return listing ? { groups, listing } : null;
};

const withListingAndGroupsPage =
  (
    renderPage: (
      listing: ListingWithCount,
      groups: Group[],
      session: AdminSession,
    ) => string,
  ): TypedRouteHandler<"GET /admin/listing/:id"> =>
  (request, params) =>
    requireSessionOr(request, (session) =>
      withEntityFromParam(params.id, getListingAndGroups, (ctx) =>
        htmlResponse(renderPage(ctx.listing, ctx.groups, session)),
      ),
    );

const handleAdminListingDuplicateGet: TypedRouteHandler<"GET /admin/listing/:id/duplicate"> =
  withListingAndGroupsPage(adminDuplicateListingPage);

/** Handle GET /admin/listing/:id/edit */
const handleAdminListingEditGet: TypedRouteHandler<"GET /admin/listing/:id/edit"> =
  withListingAndGroupsPage(adminListingEditPage);

/** Handle POST /admin/listing/:id/edit */
const handleAdminListingEditPost: TypedRouteHandler<
  "POST /admin/listing/:id/edit"
> = (request, { id }) =>
  withAuth(request, AUTH_MULTIPART, (session, formData) =>
    withEntityFromParam(id, getListingWithCount, async (existing) => {
      const form = formDataToParams(formData);
      applyDemoOverrides(form, LISTING_DEMO_FIELDS);

      // Build a resource that includes the slug field; uniqueness is enforced
      // by validateListingInput when existingId is set.
      const updateResource = defineResource({
        fields: [
          ...listingFields,
          monthsPerUnitField,
          initialSiteMonthsField,
          assignBuiltSiteField,
          slugField,
          groupIdField,
        ],
        nameField: "name",
        table: listingsTable,
        toInput: extractListingUpdateInput,
        validate: validateListingInput,
      });

      const result = await updateResource.update(id, form);
      if (result.ok) {
        // If duration changed on a daily listing, reconcile existing booking ranges
        // so stored end_at values match the listing's current policy.
        let durationWarning = "";
        if (
          result.row.listing_type === "daily" &&
          result.row.duration_days !== existing.duration_days
        ) {
          await recomputeListingBookingRanges(
            result.row.id,
            result.row.duration_days,
          );
          await logActivity(
            `Listing '${result.row.name}' duration changed to ${result.row.duration_days} day(s)`,
            result.row,
          );
          const overDay = await checkGroupCapAfterDurationChange(
            result.row.id,
            result.row.group_id,
          );
          if (overDay) {
            durationWarning = ` Warning: group capacity exceeded on ${overDay}`;
            await logActivity(
              `Duration change caused group capacity overflow on ${overDay}`,
              result.row,
            );
          }
        }
        await logActivity(`Listing '${result.row.name}' updated`, result.row);
        return processUploadsAndRedirect(
          formData,
          id,
          `/admin/listing/${result.row.id}`,
          `Listing updated${durationWarning}`,
          existing.image_url,
          existing.attachment_url,
        );
      }
      if ("notFound" in result) return notFoundResponse();

      const ctx = await getListingAndGroups(id);
      return ctx
        ? htmlResponse(
            adminListingEditPage(
              ctx.listing,
              ctx.groups,
              session,
              result.error,
            ),
            400,
          )
        : notFoundResponse();
    }),
  );

/**
 * Handle GET /admin/listing/:id/export (CSV export)
 */
const handleAdminListingExport: TypedRouteHandler<
  "GET /admin/listing/:id/export"
> = (request, { id }) =>
  listingAttendeesLoader(
    request,
    id,
  )(
    listingAttendeesHandler(async ({ listing, attendees }) => {
      const { dateFilter, filteredByDate } = applyDateFilter(
        listing,
        attendees,
        request,
      );
      const isDaily = listing.listing_type === "daily";

      // Load questions and attendee answers for CSV
      const attendeeIds = filteredByDate.map((a) => a.id);
      const [questions, attendeeAnswerMap] = await Promise.all([
        getQuestionsForListing(listing.id),
        getAttendeeAnswersBatch(attendeeIds),
      ]);
      const questionData: CsvQuestionData | undefined =
        questions.length > 0 ? { attendeeAnswerMap, questions } : undefined;

      const csv = generateAttendeesCsv(
        filteredByDate,
        isDaily,
        {
          listingDate: listing.date,
          listingLocation: listing.location,
        },
        questionData,
        listing.duration_days,
      );
      const sanitizedName = listing.name.replace(/[^a-zA-Z0-9]/g, "_");
      const filename = dateFilter
        ? `${sanitizedName}_${dateFilter}_attendees.csv`
        : `${sanitizedName}_attendees.csv`;
      await logActivity(
        `CSV exported for '${listing.name}'${
          dateFilter ? ` (date: ${dateFilter})` : ""
        }`,
        listing,
      );
      return csvResponse(csv, filename);
    }),
  );

/** Shared config for listing confirmation handlers */
const listingConfirmBase = {
  auth: "any" as const,
  identifier: (listing: ListingWithCount) => listing.name,
  identifierLabel: "Listing name",
  load: (_id: number) => getListingWithCount(_id),
};

/** Factory for listing toggle handlers (deactivate/reactivate) */
const listingToggleHandlers = (opts: {
  active: boolean;
  action: string;
  renderPage: (
    listing: ListingWithCount,
    session: { readonly adminLevel: "owner" | "manager" },
    error?: string,
  ) => string;
}) =>
  createConfirmedHandlers<ListingWithCount>({
    ...listingConfirmBase,
    actionLabel: `${opts.action}ion`,
    onConfirm: async (listing, id) => {
      await listingsTable.update(id, { active: opts.active });
      await logActivity(`Listing '${listing.name}' ${opts.action}d`, id);
    },
    path: `/admin/listing/:id/${opts.action}`,
    render: opts.renderPage,
    successMessage: `Listing ${opts.action}d`,
    successRedirect: (_, id) => `/admin/listing/${id}`,
  });

const listingDeactivate = listingToggleHandlers({
  action: "deactivate",
  active: false,
  renderPage: adminDeactivateListingPage,
});

const listingReactivate = listingToggleHandlers({
  action: "reactivate",
  active: true,
  renderPage: adminReactivateListingPage,
});

/** Confirmed-delete handlers for listings */
const listingDelete = createConfirmedHandlers<ListingWithCount>({
  ...listingConfirmBase,
  onConfirm: async (listing) => {
    await performListingDelete(listing);
  },
  path: "/admin/listing/:id/delete",
  render: (listing, session, error) =>
    adminDeleteListingPage(listing, session, error),
  successMessage: "Listing deleted",
  successRedirect: "/admin",
});

/**
 * Handle GET /admin/listing/:id/log
 * Uses batched query to fetch listing + activity log in a single DB round-trip.
 */
const handleAdminListingLog = authenticatedGetById(null)(
  getListingWithActivityLog,
  (result, session) =>
    htmlResponse(
      adminListingActivityLogPage(result.listing, result.entries, session),
    ),
);

/** Handle DELETE /admin/listing/:id (delete listing with logging) */
const handleAdminListingDelete: TypedRouteHandler<
  "POST /admin/listing/:id/delete"
> = (request, { id }) =>
  getSearchParam(request, "verify_identifier") !== "false"
    ? listingDelete.post(request, id)
    : withAuth(request, AUTH_FORM, () =>
        withEntityFromParam(id, getListingWithCount, async (listing) => {
          await performListingDelete(listing);
          return redirect("/admin", "Listing deleted", true);
        }),
      );

/** Generic handler for deleting an listing's uploaded file (image or attachment) */
const handleFileDelete =
  (
    label: string,
    getUrl: (e: ListingWithCount) => string,
    clearFields: Partial<ListingInput>,
  ): TypedRouteHandler<`POST /admin/listing/:id/${string}/delete`> =>
  (request, { id }) =>
    withAuth(request, AUTH_FORM, () =>
      withEntityFromParam(id, getListingWithCount, async (listing) => {
        const url = getUrl(listing);
        if (url) {
          const [deleteResult] = await Promise.allSettled([deleteFile(url)]);
          if (deleteResult.status === "fulfilled") {
            await listingsTable.update(id, clearFields);
            await logActivity(
              `${label} removed for '${listing.name}'`,
              listing,
            );
            return redirect(`/admin/listing/${id}`, `${label} removed`, true);
          }
          const detail = `${label} removal failed: ${String(
            deleteResult.reason,
          )}`;
          logError({
            code: ErrorCode.STORAGE_DELETE,
            detail,
            listingId: listing.id,
          });
          return redirect(
            `/admin/listing/${id}`,
            `${label} removal failed`,
            false,
          );
        }
        return redirect(`/admin/listing/${id}`, `${label} removed`, true);
      }),
    );

/** Handle POST /admin/listing/:id/image/delete (delete listing image) */
const handleImageDelete = handleFileDelete("Image", (e) => e.image_url, {
  imageUrl: "",
});

/** Handle POST /admin/listing/:id/attachment/delete (delete listing attachment) */
const handleAttachmentDelete = handleFileDelete(
  "Attachment",
  (e) => e.attachment_url,
  { attachmentName: "", attachmentUrl: "" },
);

/** Create a handler that renders the listing page with a specific attendee filter */
const listingPageHandler =
  (
    activeFilter?: AttendeeFilter,
  ): TypedRouteHandler<"GET /admin/listing/:id"> =>
  (request, params) =>
    renderListingPage(request, params, activeFilter);

/** Handle GET /admin/listing/:id */
const handleAdminListingGet = listingPageHandler();

/** Handle GET /admin/listing/:id/in (checked-in filter) */
const handleAdminListingGetIn = listingPageHandler("in");

/** Handle GET /admin/listing/:id/out (not-checked-in filter) */
const handleAdminListingGetOut = listingPageHandler("out");

/** Listing routes */
export const listingsRoutes = {
  ...listingDeactivate.routes,
  ...listingReactivate.routes,
  ...listingDelete.routes,
  ...defineRoutes({
    "DELETE /admin/listing/:id/delete": handleAdminListingDelete,
    "GET /admin/listing/:id": handleAdminListingGet,
    "GET /admin/listing/:id/duplicate": handleAdminListingDuplicateGet,
    "GET /admin/listing/:id/edit": handleAdminListingEditGet,
    "GET /admin/listing/:id/export": handleAdminListingExport,
    "GET /admin/listing/:id/in": handleAdminListingGetIn,
    "GET /admin/listing/:id/log": handleAdminListingLog,
    "GET /admin/listing/:id/out": handleAdminListingGetOut,
    "GET /admin/listing/new": handleNewListingGet,
    "POST /admin/listing": handleCreateListing,
    "POST /admin/listing/:id/attachment/delete": handleAttachmentDelete,
    "POST /admin/listing/:id/delete": handleAdminListingDelete,
    "POST /admin/listing/:id/edit": handleAdminListingEditPost,
    "POST /admin/listing/:id/image/delete": handleImageDelete,
  }),
};
