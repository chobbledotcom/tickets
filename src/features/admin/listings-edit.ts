/**
 * Listing create / duplicate / edit routes.
 *
 * The create and update flows share the form-extraction resources
 * (`listings-form.ts`) and the file-upload handling (`listings-uploads.ts`);
 * this module wires them to the new/edit/duplicate pages.
 */

import { logActivity } from "#db/activity-log.ts";
import { listingGroups } from "#db/groups/table.ts";
import { anyHiddenPackageGroup, groups } from "#db/groups.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { adjustListingIncome } from "#db/listings/aggregates.ts";
import {
  getListingWithCount,
  getStoredListingWithCount,
  requireListingWithCount,
} from "#db/listings/records.ts";
import { settings } from "#db/settings.ts";
/* jscpd:ignore-start */
import { t } from "#i18n";
import {
  adminLandingPath,
  CONTENT_MULTIPART,
  contentMultipartRoute,
  requireContentOr,
  withAuth,
} from "#routes/auth.ts";
import { createIdEntityHandler } from "#routes/entity.ts";
import { htmlResponse, notFoundResponse } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { entityReturnPath } from "#shared/admin-pages.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  dimensionsOf,
  inferTemplate,
  LISTING_TEMPLATES,
  type ListingTemplate,
  submissionRequiresDate,
} from "#shared/listing-templates.ts";
import {
  adminDuplicateListingPage,
  adminListingNewPage,
  adminListingPickerPage,
} from "#templates/admin/listings/form-pages.tsx";
import {
  type AdminSession,
  isListingType,
  type ListingWithCount,
} from "#types";
import { withEntityFromParam } from "./entity-handlers.ts";
import { getListingAndGroups } from "./listing-page-data.ts";
import {
  handleListingEditSuccess,
  parseAggregatesForRole,
  renderListingEditError,
} from "./listings-edit-save.ts";
import {
  buildCreateListingResource,
  buildUpdateListingResource,
  parseGroupIds,
  parseListingForm,
} from "./listings-form.ts";
import { copyDuplicatedChildEdges } from "./listings-parents.ts";
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
  requireContentOr(request, async (session) => {
    const templateParam = new URL(request.url).searchParams.get("template");
    if (!templateParam) {
      return htmlResponse(adminListingPickerPage(session));
    }
    const gate = chosenTemplateOrPicker(templateParam, session);
    if ("picker" in gate) return gate.picker;
    return renderNewListingPage(session, {
      templateId: gate.template?.id ?? "custom",
    });
  });

/** Look up the operator's chosen listing template. A template that needs
 * logistics while the feature is off is unavailable, so the picker page is
 * given back instead — the create GET gate and the create POST backstop (a
 * form opened while logistics was enabled, or a crafted POST) share this
 * guard. */
const chosenTemplateOrPicker = (
  templateId: string | null,
  session: AdminSession,
): { template: ListingTemplate | null } | { picker: Response } => {
  const template =
    LISTING_TEMPLATES.find((candidate) => candidate.id === templateId) ?? null;
  return template?.requiresLogistics && !settings.features.logistics
    ? { picker: htmlResponse(adminListingPickerPage(session)) }
    : { template };
};

/** Load every group and render the new-listing form. Shared by the empty-form
 *  GET and the rejected-create re-render, which both fetch the group list then
 *  hand it to {@link adminListingNewPage}. */
const renderNewListingPage = async (
  session: AdminSession,
  opts: Parameters<typeof adminListingNewPage>[2],
  status?: number,
): Promise<Response> => {
  const allGroups = await groups.cache.getAll();
  return htmlResponse(adminListingNewPage(allGroups, session, opts), status);
};

/** Build a DimensionSource from submitted form params. */
const formToDimensionSource = (form: FormParams) => ({
  date: form.getString("date_date") || "",
  listing_type: isListingType(form.getString("listing_type"))
    ? (form.getString("listing_type") as "standard" | "daily")
    : ("standard" as const),
  purchase_only: form.getFlag("purchase_only"),
  uses_logistics: form.getFlag("uses_logistics"),
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
 * Copy a duplicated parent's required-child edges onto its new copy, so the
 * copy keeps its gate. The children are not duplicated: the copy references the
 * same child listings.
 *
 * Returns a **warning** when the gate could not be copied, because the edges
 * failed re-validation on the copy. A swallowed failure would leave a gateless
 * standalone bookable listing behind a silent success.
 */
const copyEdgesFromDuplicateSource = async (
  form: FormParams,
  newId: number,
): Promise<string | null> => {
  const sourceId = form.getOptionalInt("duplicated_from");
  if (sourceId === null) return null;
  // The source's per-package price/quantity is copied onto the copy's membership
  // rows atomically in the create write's afterWrite (see buildCreateListingResource);
  // here we only carry the parent/child gate.
  const childIds = await listingChildren.getIds(sourceId);
  if (childIds.length === 0) return null;
  // A HIDDEN package's member can't gate required children (its members are
  // collapsed to the package name, so a child selector would leak them), so a
  // copy that joined a hidden package group must not inherit the source's child
  // edges — keep it a valid member and tell the operator the gate wasn't
  // carried over, mirroring the children endpoint's package invariant that the
  // create path would otherwise bypass. A visible package renders the member's
  // child selector, so its copy keeps the gate.
  if (await anyHiddenPackageGroup(await listingGroups.getIds(newId))) {
    return t("listings_table.duplicate_children_dropped", {
      reason: t("error.package_member_no_children"),
    });
  }
  // The copy was just created in this request, so it always loads.
  const newListing = await requireListingWithCount(newId);
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
  return renderNewListingPage(
    session,
    {
      customiseOpen: form.getFlag("customise"),
      error,
      // The group checkboxes the operator submitted, so a rejected create
      // re-renders their selection rather than dropping every group.
      selectedGroupIds: parseGroupIds(form),
      templateId,
      values: form.toRenderValues(),
    },
    400,
  );
};

/**
 * Handle POST /admin/listing (create listing)
 */
export const handleCreateListing: TypedRouteHandler<"POST /admin/listing"> =
  contentMultipartRoute(async (session, formData) => {
    const form = parseListingForm(session, formData, {
      useDefaults: false,
      webhookUrl: "",
    });

    // Mirror the GET gate: reject logistics templates when the feature is off.
    const chosenTemplateId = form.getString("template_id") || null;
    const gate = chosenTemplateOrPicker(chosenTemplateId, session);
    if ("picker" in gate) return gate.picker;

    // Template-specific date validation: reject a blank date when the operator
    // chose the one-off-event template and hasn't changed the non-date dims.
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
    // Staff land on the dashboard, which renders flashes. An editor cannot
    // open the dashboard, so they go to the new listing's own page, which
    // renders Flash too: the success message and any upload caveats show.
    const createdRedirect =
      session.adminLevel === "editor"
        ? entityReturnPath("/admin/listings", result.row.id)
        : adminLandingPath(session.adminLevel);
    return processUploadsAndRedirect(
      formData,
      result.row.id,
      createdRedirect,
      t("success.listing_created"),
      undefined,
      childWarning,
    );
  });

type ListingAndGroups = NonNullable<
  Awaited<ReturnType<typeof getListingAndGroups>>
>;
const listingAndGroupsHandler =
  createIdEntityHandler<ListingAndGroups>(getListingAndGroups)(
    requireContentOr,
  );

/**
 * Session-guarded GET handler that loads the listing + groups context and
 * renders a page from it. Shared by the duplicate and edit forms.
 */
const listingAndGroupsPage = (
  renderPage: (
    ctx: ListingAndGroups,
    session: AdminSession,
    request: Request,
  ) => string,
): TypedRouteHandler<"GET /admin/listing/:id"> =>
  listingAndGroupsHandler((ctx, session, request) =>
    htmlResponse(renderPage(ctx, session, request)),
  );

/** Handle GET /admin/listing/:id/duplicate */
export const handleAdminListingDuplicateGet: TypedRouteHandler<"GET /admin/listing/:id/duplicate"> =
  listingAndGroupsPage((ctx, session) =>
    adminDuplicateListingPage(
      ctx.listing,
      ctx.groups,
      session,
      ctx.selectedGroupIds,
    ),
  );

/** Handle POST /admin/listing/:id/edit */
export const handleAdminListingEditPost: TypedRouteHandler<
  "POST /admin/listing/:id/edit"
> = (request, { id }) =>
  withAuth(request, CONTENT_MULTIPART, (session, formData) =>
    withEntityFromParam(id, getStoredListingWithCount, async (existing) => {
      // `existing` holds the listing's *stored* values (defaults not overlaid):
      // a save preserves the listing's own columns, and the editor field locks
      // re-apply the real stored webhook URL and use_defaults flag.
      const form = parseListingForm(session, formData, {
        useDefaults: existing.use_defaults,
        webhookUrl: existing.webhook_url,
      });
      // The group checkboxes the operator submitted, so a rejected edit
      // re-renders their selection rather than the saved membership.
      const aggregates = parseAggregatesForRole(session, form);
      if (!aggregates.ok) {
        return renderListingEditError(id, session, form, aggregates.error);
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
      return renderListingEditError(id, session, form, result.error);
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
