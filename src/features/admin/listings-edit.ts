/**
 * Listing create / duplicate / edit routes.
 *
 * The create and update flows share the form-extraction resources
 * (`listings-form.ts`) and the file-upload handling (`listings-uploads.ts`);
 * this module wires them to the new/edit/duplicate pages.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { parseEditableAggregateForm } from "#routes/admin/aggregate-recalculation.ts";
import { AUTH_MULTIPART, requireSessionOr, withAuth } from "#routes/auth.ts";
import { applyFlash, formDataToParams } from "#routes/csrf.ts";
import { htmlResponse, notFoundResponse } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import {
  checkGroupCapAfterDurationChange,
  recomputeListingBookingRanges,
} from "#shared/db/attendees.ts";
import { getAllGroups } from "#shared/db/groups.ts";
import { getChildIds } from "#shared/db/listing-parents.ts";
import {
  adjustListingIncome,
  getListingAggregateRecalculation,
  getListingWithCount,
  type ListingAggregateRecalculation,
  type ListingAggregateValues,
  updateListingAggregateValues,
} from "#shared/db/listings.ts";
import { applyDemoOverrides, LISTING_DEMO_FIELDS } from "#shared/demo.ts";
import { settings } from "#shared/db/settings.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  dimensionsOf,
  inferTemplate,
  LISTING_TEMPLATES,
  submissionRequiresDate,
} from "#shared/listing-templates.ts";
import type {
  AdminSession,
  Group,
  Listing,
  ListingWithCount,
} from "#shared/types.ts";
import { isListingType } from "#shared/types.ts";
import {
  adminDuplicateListingPage,
  adminListingEditPage,
  adminListingNewPage,
  adminListingPickerPage,
} from "#templates/admin/listings.tsx";
import type { ListingAggregateFormValues } from "#templates/fields.ts";
import { listingAggregateFields } from "#templates/fields.ts";
import { withEntityFromParam } from "./entity-handlers.ts";
import {
  buildCreateListingResource,
  buildUpdateListingResource,
  extractListingAggregateValues,
} from "./listings-form.ts";
import {
  copyDuplicatedChildEdges,
  loadListingParentsSection,
} from "./listings-parents.ts";
import { processUploadsAndRedirect } from "./listings-uploads.ts";
import { makeMoneyAdjustHandler } from "./money-adjust.ts";
/* jscpd:ignore-end */

/**
 * Handle GET /admin/listing/new (show picker or create form)
 *
 * No ?template param → show the type-picker card page.
 * ?template=<known-id> → show the seeded, Customise-collapsed create form.
 * ?template=custom or unknown value → show the full form with Customise open.
 */
export const handleNewListingGet: TypedRouteHandler<
  "GET /admin/listing/new"
> = (request) =>
  requireSessionOr(request, async (session) => {
    const templateParam = new URL(request.url).searchParams.get("template");
    if (!templateParam) {
      return htmlResponse(adminListingPickerPage(session));
    }
    const template = LISTING_TEMPLATES.find((t) => t.id === templateParam) ?? null;
    // Logistics-requiring templates are unavailable when the feature is disabled.
    if (template?.requiresLogistics && !settings.hasLogistics) {
      return htmlResponse(adminListingPickerPage(session));
    }
    const groups = await getAllGroups();
    return htmlResponse(
      adminListingNewPage(groups, session, { templateId: template?.id ?? "custom" }),
    );
  });

/** Build a DimensionSource from submitted form params. */
const formToDimensionSource = (form: FormParams) => ({
  listing_type: isListingType(form.getString("listing_type"))
    ? (form.getString("listing_type") as "standard" | "daily")
    : ("standard" as const),
  date: form.getString("date_date") || "",
  purchase_only: form.getString("purchase_only") === "1",
  uses_logistics: form.getString("uses_logistics") === "1",
});

/**
 * Resolve the effective template id for a POST error re-render.
 *
 * Uses the carried `template_id` hidden field when present; falls back to
 * inferring a template from the submitted dimensions so a duplicate form
 * (which has no template_id) re-renders with the right collapse state.
 */
const resolveErrorTemplateId = (form: FormParams): string | null => {
  const carried = form.getString("template_id");
  if (carried) return carried;
  return inferTemplate(formToDimensionSource(form))?.id ?? null;
};

/**
 * After creating a listing from the duplicate form, copy the source parent's
 * required-child edges onto the new copy so a duplicated parent keeps its
 * required-child gate (the children themselves are not duplicated — the copy
 * references the same existing child listings). Reads the source id from the
 * hidden `duplicated_from` field; a plain create (no source) is a no-op, as is a
 * source with no children or the flag being off ({@link copyDuplicatedChildEdges}).
 *
 * Returns a **warning** message when the gate could NOT be copied (the edges
 * failed re-validation on the copy — e.g. the child carries an opt-in add-on
 * reachable only through the source parent, so it would dead-end from the new
 * one). Surfacing this instead of swallowing it (Fix 1) prevents a silent
 * "success" that leaves the copy a gateless standalone bookable listing; the copy
 * is kept but the operator is told its required children weren't carried over.
 * Returns null when the edges copied cleanly (or there were none to copy).
 */
const copyEdgesFromDuplicateSource = async (
  form: FormParams,
  newId: number,
): Promise<string | null> => {
  const sourceId = form.getOptionalInt("duplicated_from");
  if (sourceId === null) return null;
  const childIds = await getChildIds(sourceId);
  if (childIds.length === 0) return null;
  // The copy was just created in this request, so it always loads.
  const newListing = (await getListingWithCount(newId))!;
  const error = await copyDuplicatedChildEdges(newListing, childIds);
  return error
    ? t("listings_table.duplicate_children_dropped", { reason: error })
    : null;
};

const renderCreateListingError = async (
  session: AdminSession,
  form: FormParams,
  error: string,
  templateId: string | null,
): Promise<Response> => {
  const groups = await getAllGroups();
  return htmlResponse(
    adminListingNewPage(groups, session, {
      customiseOpen: form.getString("customise") === "1",
      error,
      templateId,
    }),
    400,
  );
};

/**
 * Handle POST /admin/listing (create listing)
 */
export const handleCreateListing: TypedRouteHandler<"POST /admin/listing"> = (
  request,
) =>
  withAuth(request, AUTH_MULTIPART, async (session, formData) => {
    const form = formDataToParams(formData);
    applyDemoOverrides(form, LISTING_DEMO_FIELDS);

    // Template-specific date validation: reject a blank date when the operator
    // chose the one-off-event template and hasn't changed the non-date dims.
    const chosenTemplateId = form.getString("template_id") || null;
    const submittedDims = dimensionsOf(formToDimensionSource(form));
    if (
      submissionRequiresDate(chosenTemplateId, submittedDims) &&
      !form.getString("date_date")
    ) {
      return renderCreateListingError(
        session,
        form,
        t("listings_table.date_required_for_one_off"),
        chosenTemplateId,
      );
    }

    const result = await buildCreateListingResource(form).create(form);
    if (!result.ok) {
      return renderCreateListingError(
        session,
        form,
        result.error,
        resolveErrorTemplateId(form),
      );
    }
    await logActivity(`Listing '${result.row.name}' created`, result.row);
    const childWarning = await copyEdgesFromDuplicateSource(
      form,
      result.row.id,
    );
    return processUploadsAndRedirect(
      formData,
      result.row.id,
      "/admin",
      t("success.listing_created"),
      undefined,
      undefined,
      childWarning,
    );
  });

/** Listing + its groups + aggregate recalculation, loaded for the edit pages. */
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

type ListingAndGroups = NonNullable<
  Awaited<ReturnType<typeof getListingAndGroups>>
>;

/**
 * Session-guarded GET handler that loads the listing + groups context and
 * renders a page from it. Shared by the duplicate and edit forms.
 */
const listingAndGroupsPage =
  (
    renderPage: (
      ctx: ListingAndGroups,
      session: AdminSession,
      request: Request,
    ) => string,
  ): TypedRouteHandler<"GET /admin/listing/:id"> =>
  (request, params) =>
    requireSessionOr(request, (session) =>
      withEntityFromParam(params.id, getListingAndGroups, (ctx) =>
        htmlResponse(renderPage(ctx, session, request)),
      ),
    );

/** Handle GET /admin/listing/:id/duplicate */
export const handleAdminListingDuplicateGet: TypedRouteHandler<"GET /admin/listing/:id/duplicate"> =
  listingAndGroupsPage((ctx, session) =>
    adminDuplicateListingPage(ctx.listing, ctx.groups, session),
  );

/** Handle GET /admin/listing/:id/edit */
export const handleAdminListingEditGet: TypedRouteHandler<
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
          await loadListingParentsSection(ctx.listing),
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
          await loadListingParentsSection(ctx.listing),
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
export const handleAdminListingEditPost: TypedRouteHandler<
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

/**
 * Handle POST /admin/listing/:id/income — post a manual `writeoff` adjustment so
 * the listing's projected income matches the owner-entered figure (decision 14).
 * Owner-only; the delta is computed from the listing's current projected income.
 */
const adjustListingIncomeForm = makeMoneyAdjustHandler<ListingWithCount>({
  adjust: (listing, target) => adjustListingIncome(listing.id, target),
  editPath: (id) => `/admin/listing/${id}/edit`,
  field: "income",
  load: getListingWithCount,
  logMessage: (listing) => `Listing '${listing.name}' income adjusted`,
  successMessage: t("listings_table.adjust_income_success"),
});

/** Handle POST /admin/listing/:id/income */
export const handleAdminListingIncomePost: TypedRouteHandler<
  "POST /admin/listing/:id/income"
> = (request, { id }) => adjustListingIncomeForm(request, id);
