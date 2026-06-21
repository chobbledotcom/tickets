/**
 * Admin listing management routes
 */

import { compact, filter, map, pipe, sort, unique } from "#fp";
import { t } from "#i18n";
import {
  csvResponse,
  getDateFilter,
  listingAttendeesLoader,
  requirePrivateKey,
} from "#routes/admin/actions.ts";
import {
  createRecalculatePageRenderer,
  parseEditableAggregateForm,
  selectedRecalculationFields,
} from "#routes/admin/aggregate-recalculation.ts";
import {
  type CsvQuestionData,
  generateAttendeesCsv,
} from "#routes/admin/attendees-csv.ts";
import { isBuilderEnabled } from "#routes/admin/builder.ts";
import { createConfirmedHandlers } from "#routes/admin/confirmation.ts";
import {
  AUTH_FORM,
  AUTH_MULTIPART,
  type AuthSession,
  requireSessionOr,
  withAuth,
} from "#routes/auth.ts";
import { applyFlash, formDataToParams } from "#routes/csrf.ts";
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
  getChildIds,
  getParentsOf,
  setChildIds,
} from "#shared/db/listing-parents.ts";
import {
  computeSlugIndex,
  getAllListings,
  getListingAggregateRecalculation,
  getListingWithCount,
  LISTING_AGGREGATE_FIELDS,
  type ListingAggregateRecalculation,
  type ListingAggregateValues,
  type ListingInput,
  listingsTable,
  resetListingAggregateFields,
  updateListingAggregateValues,
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
import { getEnv } from "#shared/env.ts";
import { getFlash } from "#shared/flash-context.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { Field } from "#shared/forms.tsx";
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
import {
  type AdminSession,
  type Attendee,
  type DayPrices,
  type Group,
  type Listing,
  type ListingWithCount,
  parseDayPrices,
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
  adminListingRecalculatePage,
  adminReactivateListingPage,
  completePaymentAttendees,
  filterAttendees,
  type GroupContext,
} from "#templates/admin/listings.tsx";
import type {
  ListingAggregateFormValues,
  ListingEditFormValues,
  ListingFormValues,
} from "#templates/fields.ts";
import {
  getAssignBuiltSiteField,
  getGroupIdField,
  getInitialSiteMonthsField,
  getListingFields,
  getMonthsPerUnitField,
  getSlugField,
  listingAggregateFields,
  splitCsv,
} from "#templates/fields.ts";
import { withEntityFromParam } from "./entity-handlers.ts";

/** Parse comma-separated day names to string array */
const parseBookableDays = (value: string): string[] | undefined =>
  value ? splitCsv(value) : undefined;

/**
 * Read the per-day-count price inputs (`day_price_1`, `day_price_2`, …) from
 * the raw form into a {@link DayPrices} map. Only days 1..maxDays are read
 * (matching the inputs the form renders); blank rows are skipped so that count
 * isn't offered. {@link parseDayPrices} drops any non-numeric entries.
 */
const parseDayPricesFromForm = (
  form: FormParams,
  maxDays: number,
): DayPrices => {
  const result: DayPrices = {};
  for (let n = 1; n <= maxDays; n++) {
    const raw = form.getString(`day_price_${n}`).trim();
    if (raw !== "") result[n] = toMinorUnits(Number.parseFloat(raw));
  }
  return parseDayPrices(result);
};

/** Normalize an optional datetime field to UTC, passing through blanks/undefined. */
const normalizeOptionalDatetime = (
  raw: string | undefined,
  field: string,
): string | undefined => (raw ? normalizeDatetime(raw, field) : raw);

/** Parse an optional minor-units price field, undefined when blank. */
const parseOptionalPrice = (raw: string | undefined): number | undefined =>
  raw ? toMinorUnits(Number.parseFloat(raw)) : undefined;

/** Extract common listing fields from validated form values, normalizing datetimes to UTC */
const extractCommonFields = (values: ListingFormValues, form: FormParams) => {
  const webhookUrl = isDemoMode() ? "" : values.webhook_url || "";
  const durationDays = values.duration_days ?? 1;
  return {
    assignBuiltSite: isBuilderEnabled() && values.assign_built_site === "1",
    bookableDays: parseBookableDays(values.bookable_days),
    canPayMore: values.can_pay_more === "1",
    closesAt: normalizeOptionalDatetime(values.closes_at, "closes_at"),
    customisableDays: values.customisable_days === "1",
    date: normalizeOptionalDatetime(values.date, "date") ?? "",
    dayPrices: parseDayPricesFromForm(form, durationDays),
    description: values.description,
    durationDays,
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
    unitPrice: parseOptionalPrice(values.unit_price),
    usesLogistics:
      settings.hasLogistics && form.getString("uses_logistics") === "1",
    webhookUrl,
  };
};

/** Extract listing input from validated form (async to compute slugIndex) */
const extractListingInput = async (
  values: ListingFormValues,
  form: FormParams,
): Promise<ListingInput> => {
  const { slug, slugIndex } = await generateUniqueListingSlug();
  return { ...extractCommonFields(values, form), slug, slugIndex };
};

/** Extract listing input for update (reads slug from form, normalizes it) */
const extractListingUpdateInput = async (
  values: ListingEditFormValues,
  form: FormParams,
): Promise<ListingInput> => {
  const slug = normalizeSlug(values.slug);
  const slugIndex = await computeSlugIndex(slug);
  return { ...extractCommonFields(values, form), slug, slugIndex };
};

const extractListingAggregateValues = (
  values: ListingAggregateFormValues,
): ListingAggregateValues => ({
  booked_quantity: values.booked_quantity,
  income: toMinorUnits(Number.parseFloat(values.income)),
  tickets_count: values.tickets_count,
});

/** Build listing resource fields for every create/update. */
const buildListingResourceFields = (): Field[] => [
  ...getListingFields(),
  getMonthsPerUnitField(),
  getInitialSiteMonthsField(),
  getAssignBuiltSiteField(),
  getGroupIdField(),
];

/**
 * Build a per-request listings create resource whose `toInput` closes over the
 * raw form, so the dynamic `day_price_*` inputs can be read alongside the
 * validated fields (the resource only hands `toInput` the validated values).
 */
const buildCreateListingResource = (form: FormParams) =>
  defineResource({
    fields: buildListingResourceFields(),
    nameField: "name",
    table: listingsTable,
    toInput: (values: ListingFormValues) => extractListingInput(values, form),
    validate: validateListingInput,
  });

/** Build a per-request listings update resource (includes the slug field). */
const buildUpdateListingResource = (form: FormParams) =>
  defineResource({
    fields: [...buildListingResourceFields(), getSlugField()],
    nameField: "name",
    table: listingsTable,
    toInput: (values: ListingEditFormValues) =>
      extractListingUpdateInput(values, form),
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
      session: AuthSession;
    }) => Response | Promise<Response>,
  ) =>
  (listing: ListingWithCount, attendees: Attendee[], session: AuthSession) =>
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
    const result = await buildCreateListingResource(form).create(form);
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
      t("success.listing_created"),
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
        const [
          flash,
          phonePrefix,
          questions,
          answers,
          groupContext,
          aggregateRecalculation,
        ] = await Promise.all([
          Promise.resolve(getFlash()),
          Promise.resolve(settings.phonePrefix),
          getQuestionsForListing(listing.id),
          getAttendeeAnswersBatch(attendeeIds, {
            privateKey: await requirePrivateKey(session),
            texts: true,
          }),
          loadGroupContext(listing, dateFilter),
          getListingAggregateRecalculation(listing),
        ]);
        const questionData =
          questions.length > 0
            ? {
                attendeeAnswerMap: answers.answerIds,
                questions,
                textAnswerMap: answers.textAnswers,
              }
            : undefined;
        return htmlResponse(
          adminListingPage({
            activeFilter,
            aggregateRecalculation,
            allowedDomain: getEffectiveDomain(),
            attendees: filteredByDate,
            availableDates,
            checkinMessage: getCheckinMessage(request),
            dateFilter,
            errorMessage: flash.error,
            groupContext,
            // Emailing a listing targets every attendee across all dates, so
            // gate the action on the full set, not the date-filtered view.
            hasEmailableAttendees: attendees.some((a) => a.email !== ""),
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
): Promise<{
  aggregateRecalculation: ListingAggregateRecalculation;
  groups: Group[];
  listing: ListingWithCount;
} | null> => {
  const [listing, groups] = await Promise.all([
    getListingWithCount(listingId),
    getAllGroups(),
  ]);
  return listing
    ? {
        aggregateRecalculation: await getListingAggregateRecalculation(listing),
        groups,
        listing,
      }
    : null;
};

/**
 * Whether the listing parent/child relationship editor is exposed to operators.
 * Off until the booking gate that enforces it ships (see parents.md release
 * gate); gated by an env flag, mirroring the builder feature.
 */
export const isListingParentsEnabled = (): boolean =>
  getEnv("LISTING_PARENTS_ENABLED") === "true";

/** The data the edit page's "required children" section renders, or undefined
 * when the feature is disabled. `allListings` excludes the listing itself
 * (no self-edges); `childIds` are its currently-required children; `offeredUnder`
 * are the listings it is itself a child of. */
type ListingParentsSection = {
  allListings: ListingWithCount[];
  childIds: ReadonlySet<number>;
  offeredUnder: ListingWithCount[];
};

const loadListingParentsSection = async (
  listingId: number,
): Promise<ListingParentsSection | undefined> => {
  if (!isListingParentsEnabled()) return undefined;
  const [allListings, childIds, offeredUnder] = await Promise.all([
    getAllListings(),
    getChildIds(listingId),
    getParentsOf(listingId),
  ]);
  return {
    allListings: allListings.filter((l) => l.id !== listingId),
    childIds: new Set(childIds),
    offeredUnder,
  };
};

/** Handle POST /admin/listing/:id/children (set the required child listings). */
const handleAdminListingChildren: TypedRouteHandler<
  "POST /admin/listing/:id/children"
> = (request, { id }) =>
  withAuth(request, AUTH_FORM, (_session, form) =>
    withEntityFromParam(id, getListingWithCount, async (listing) => {
      if (!isListingParentsEnabled()) return notFoundResponse();
      const validIds = new Set((await getAllListings()).map((l) => l.id));
      // Drop self-edges and unknown ids here; the richer date/duration and
      // nesting compatibility rules are enforced when the booking gate ships.
      const childIds = form
        .getNumberArray("child_listing_ids")
        .filter((childId) => childId !== id && validIds.has(childId));
      await setChildIds(id, childIds);
      await logActivity(
        `Listing '${listing.name}' required children set to ${childIds.length} listing${childIds.length === 1 ? "" : "s"}`,
        listing,
      );
      return redirect(
        `/admin/listing/${id}/edit`,
        "Required children updated",
        true,
      );
    }),
  );

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
const handleAdminListingEditGet: TypedRouteHandler<
  "GET /admin/listing/:id/edit"
> = (request, params) =>
  requireSessionOr(request, (session) =>
    withEntityFromParam(params.id, getListingAndGroups, async (ctx) => {
      const flash = applyFlash(request);
      return htmlResponse(
        adminListingEditPage(
          ctx.listing,
          ctx.groups,
          session,
          flash.error,
          ctx.aggregateRecalculation,
          flash.success,
          await loadListingParentsSection(ctx.listing.id),
        ),
      );
    }),
  );

/**
 * If a daily listing's duration changed on edit, recompute booking ranges and
 * detect group-capacity overflow. Returns a string to append to the flash
 * message ("" when no reconciliation was needed or no overflow occurred).
 */
const reconcileDurationChange = async (
  row: {
    id: number;
    name: string;
    listing_type: string;
    customisable_days: boolean;
    duration_days: number;
    group_id: number;
  },
  previousDurationDays: number,
): Promise<string> => {
  if (row.listing_type !== "daily") return "";
  // For customisable-days listings each booking has its own visitor-chosen
  // span, so `duration_days` is only the maximum offered to new bookings —
  // never rewrite existing bookings' stored ranges from it.
  if (row.customisable_days) return "";
  if (row.duration_days === previousDurationDays) return "";

  await recomputeListingBookingRanges(row.id, row.duration_days);
  await logActivity(
    `Listing '${row.name}' duration changed to ${row.duration_days} day(s)`,
    row,
  );
  const overDay = await checkGroupCapAfterDurationChange(row.id, row.group_id);
  if (!overDay) return "";
  await logActivity(
    `Duration change caused group capacity overflow on ${overDay}`,
    row,
  );
  return ` Warning: group capacity exceeded on ${overDay}`;
};

const renderListingEditError = async (
  id: number,
  session: AdminSession,
  error: string,
): Promise<Response> => {
  const ctx = await getListingAndGroups(id);
  return ctx
    ? htmlResponse(
        adminListingEditPage(
          ctx.listing,
          ctx.groups,
          session,
          error,
          ctx.aggregateRecalculation,
          undefined,
          await loadListingParentsSection(id),
        ),
        400,
      )
    : notFoundResponse();
};

const handleListingEditSuccess = async (
  row: Listing,
  existing: ListingWithCount,
  aggregateValues: ListingAggregateValues | null,
  formData: FormData,
  id: number,
): Promise<Response> => {
  if (aggregateValues) {
    await updateListingAggregateValues(id, aggregateValues);
  }
  const durationWarning = await reconcileDurationChange(
    row,
    existing.duration_days,
  );
  await logActivity(`Listing '${row.name}' updated`, row);
  return processUploadsAndRedirect(
    formData,
    id,
    `/admin/listing/${row.id}`,
    `Listing updated${durationWarning}`,
    existing.image_url,
    existing.attachment_url,
  );
};

/** Handle POST /admin/listing/:id/edit */
const handleAdminListingEditPost: TypedRouteHandler<
  "POST /admin/listing/:id/edit"
> = (request, { id }) =>
  withAuth(request, AUTH_MULTIPART, (session, formData) =>
    withEntityFromParam(id, getListingWithCount, async (existing) => {
      const form = formDataToParams(formData);
      applyDemoOverrides(form, LISTING_DEMO_FIELDS);
      const aggregates = parseEditableAggregateForm<
        ListingAggregateFormValues,
        ListingAggregateValues
      >(form, listingAggregateFields, extractListingAggregateValues);
      if (!aggregates.ok) {
        return renderListingEditError(id, session, aggregates.error);
      }

      // Build a resource that includes the slug field; uniqueness is enforced
      // by validateListingInput when existingId is set.
      const result = await buildUpdateListingResource(form).update(id, form);
      if (result.ok) {
        return handleListingEditSuccess(
          result.row,
          existing,
          aggregates.input,
          formData,
          id,
        );
      }
      if ("notFound" in result) return notFoundResponse();
      return renderListingEditError(id, session, result.error);
    }),
  );

const renderListingRecalculatePage = createRecalculatePageRenderer(
  getListingAggregateRecalculation,
  adminListingRecalculatePage,
);

const handleListingRecalculateGet: TypedRouteHandler<
  "GET /admin/listings/recalculate/:listingId"
> = (request, { listingId }) =>
  requireSessionOr(request, (session) =>
    withEntityFromParam(listingId, getListingWithCount, (listing) => {
      applyFlash(request);
      const flash = getFlash();
      return renderListingRecalculatePage(
        listing,
        session,
        flash.error,
        flash.success,
      );
    }),
  );

const handleListingRecalculatePost: TypedRouteHandler<
  "POST /admin/listings/recalculate/:listingId"
> = (request, { listingId }) =>
  withAuth(request, AUTH_FORM, (session, form) =>
    withEntityFromParam(listingId, getListingWithCount, async (listing) => {
      const selected = selectedRecalculationFields(
        form,
        LISTING_AGGREGATE_FIELDS,
      );
      if (selected.length === 0) {
        return renderListingRecalculatePage(
          listing,
          session,
          t("listings_table.recalculate_choose"),
        );
      }
      await resetListingAggregateFields(listing.id, selected);
      await logActivity(
        `Listing '${listing.name}' totals recalculated`,
        listing,
      );
      return redirect(
        `/admin/listing/${listing.id}/edit`,
        t("listings_table.recalculate_success"),
        true,
      );
    }),
  );

/** Parse the ?checkin= filter on the export route, defaulting to "all". */
const checkinFromRequest = (request: Request): AttendeeFilter => {
  const raw = getSearchParam(request, "checkin");
  return raw === "in" || raw === "out" ? raw : "all";
};

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
    listingAttendeesHandler(async ({ listing, attendees, session }) => {
      const { dateFilter, filteredByDate } = applyDateFilter(
        listing,
        attendees,
        request,
      );
      const isDaily = listing.listing_type === "daily";
      // Mirror the on-screen attendee table: drop the failed-payment rows
      // that are split into the Failed Payments section, then apply the
      // /in /out check-in filter.
      const exported = filterAttendees(
        completePaymentAttendees(listing, filteredByDate),
        checkinFromRequest(request),
      );

      // Load questions and attendee answers (including free-text) for CSV
      const attendeeIds = exported.map((a) => a.id);
      const [questions, answers] = await Promise.all([
        getQuestionsForListing(listing.id),
        getAttendeeAnswersBatch(attendeeIds, {
          privateKey: await requirePrivateKey(session),
          texts: true,
        }),
      ]);
      const questionData: CsvQuestionData | undefined =
        questions.length > 0
          ? {
              attendeeAnswerMap: answers.answerIds,
              questions,
              textAnswerMap: answers.textAnswers,
            }
          : undefined;

      const csv = generateAttendeesCsv(
        exported,
        isDaily,
        {
          listingDate: listing.date,
          listingLocation: listing.location,
        },
        questionData,
        settings.timezone,
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
    session: AdminSession,
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
  successMessage: t("success.listing_deleted"),
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
          return redirect("/admin", t("success.listing_deleted"), true);
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
    "GET /admin/listings/recalculate/:listingId": handleListingRecalculateGet,
    "POST /admin/listing": handleCreateListing,
    "POST /admin/listing/:id/attachment/delete": handleAttachmentDelete,
    "POST /admin/listing/:id/children": handleAdminListingChildren,
    "POST /admin/listing/:id/delete": handleAdminListingDelete,
    "POST /admin/listing/:id/edit": handleAdminListingEditPost,
    "POST /admin/listing/:id/image/delete": handleImageDelete,
    "POST /admin/listings/recalculate/:listingId": handleListingRecalculatePost,
  }),
};
