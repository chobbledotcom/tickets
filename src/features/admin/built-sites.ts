/**
 * Admin built site management routes - owner only
 */

import { createOwnerCrudHandlers } from "#routes/admin/owner-crud.ts";
import { requireOwnerOr } from "#routes/auth.ts";
import { applyFlash, requireCsrfForm } from "#routes/csrf.ts";
import {
  htmlResponse,
  notFoundResponse,
  redirectResponse,
} from "#routes/response.ts";
import type { RouteParams } from "#routes/router.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import type { BuiltSite, BuiltSiteFormInput } from "#shared/db/built-sites.ts";
import {
  builtSitesCrudTable,
  getAllBuiltSites,
  updateBuiltSiteRenewalState,
} from "#shared/db/built-sites.ts";
import { getAllEvents } from "#shared/db/events.ts";
import { isProvisioned } from "#shared/renewal-helpers.ts";
import { defineNamedResource } from "#shared/rest/resource.ts";
import {
  addMonthsToRenewalDeadline,
  type TierEvent as FullTierEvent,
  isQualifyingTierEvent,
  provisionSiteRenewal,
  renewalUrlFor,
  rotateRenewalToken,
  syncReadOnlyFrom,
} from "#shared/site-assignment.ts";
import {
  adminBuiltSiteDeletePage,
  adminBuiltSiteEditPage,
  adminBuiltSiteNewPage,
  adminBuiltSitesPage,
  type RenewalTierOption,
} from "#templates/admin/built-sites.tsx";
import { builtSiteFields } from "#templates/fields.ts";

/** Extract built site input from validated form values */
const extractBuiltSiteInput = (
  values: Record<string, string | number | null>,
): BuiltSiteFormInput => ({
  assignable: values.assignable === "1",
  bunnyScriptId: String(values.bunny_script_id),
  bunnyUrl: String(values.bunny_url),
  dbToken: String(values.db_token),
  dbUrl: String(values.db_url),
  name: String(values.name),
});

/** Built sites resource for REST create/update operations */
const builtSitesResource = defineNamedResource({
  fields: builtSiteFields,
  nameField: "name",
  table: builtSitesCrudTable,
  toInput: extractBuiltSiteInput,
});

/** Tier-event options visible in the admin renewal panel */
const toTierOption = (e: FullTierEvent): RenewalTierOption => ({
  id: e.id,
  months_per_unit: e.months_per_unit,
  name: e.name,
  unit_price: e.unit_price,
});

const loadTierOptions = async (): Promise<RenewalTierOption[]> => {
  const events = await getAllEvents();
  return events.filter(isQualifyingTierEvent).map(toTierOption);
};

const crud = createOwnerCrudHandlers({
  getAll: getAllBuiltSites,
  getName: (s) => s.name,
  listPath: "/admin/built-sites",
  renderDelete: adminBuiltSiteDeletePage,
  // editGet is overridden below so we can pre-load tier options;
  // this fallback is only hit by editPost on validation failure.
  renderEdit: (site, session, error) =>
    adminBuiltSiteEditPage(site, session, [], error),
  renderList: adminBuiltSitesPage,
  renderNew: adminBuiltSiteNewPage,
  resource: builtSitesResource,
  singular: "Built site",
});

const BUILT_SITES_PATH = "/admin/built-sites";
const editPath = (id: number): string => `/admin/built-sites/${id}/edit`;
const redirectToEdit = (id: number): Response => redirectResponse(editPath(id));

/** Max months any single bump/provision can request — guards against form tampering. */
const MAX_RENEWAL_MONTHS = 120;

const readClampedMonths = (form: {
  getString: (key: string) => string;
}): number => {
  const months = Number.parseInt(form.getString("months") || "1", 10);
  if (!Number.isFinite(months) || months < 1) return 1;
  return Math.min(months, MAX_RENEWAL_MONTHS);
};

type TierForm = { getString: (key: string) => string };

const readAllowedTierId =
  (provisioned: boolean, tiers: RenewalTierOption[]) =>
  (site: BuiltSite, form: TierForm): number | null => {
    if (isProvisioned(site) !== provisioned) return null;
    const tierEventId = Number(form.getString("tier_event_id"));
    return tiers.some(({ id }) => id === tierEventId) ? tierEventId : null;
  };

type OwnerPostHandler = (
  site: BuiltSite,
  form: TierForm,
  tiers: RenewalTierOption[],
  id: number,
) => Promise<Response>;

/** Owner-gated POST handler wrapper: loads tier options, authenticates, parses CSRF. */
const ownerPost =
  (handler: OwnerPostHandler) =>
  (request: Request, params: RouteParams): Promise<Response> =>
    requireOwnerOr(request, async () => {
      const id = Number(params.id);
      if (!id) return redirectResponse(BUILT_SITES_PATH);
      const site = await builtSitesCrudTable.findById(id);
      if (!site) return redirectResponse(BUILT_SITES_PATH);
      const csrfResult = await requireCsrfForm(request, () =>
        htmlResponse("CSRF token invalid", 403),
      );
      if (!csrfResult.ok) return csrfResult.response;
      const tiers = await loadTierOptions();
      return handler(site, csrfResult.form, tiers, id);
    });

/** GET /admin/built-sites/:id/edit — pre-loads tier options for the renewal panel. */
const handleEditGet = (request: Request, params: RouteParams) =>
  requireOwnerOr(request, async (session) => {
    const id = Number(params.id);
    if (!id) return notFoundResponse();
    const site = await builtSitesCrudTable.findById(id);
    if (!site) return notFoundResponse();
    applyFlash(request);
    const tiers = await loadTierOptions();
    return htmlResponse(adminBuiltSiteEditPage(site, session, tiers));
  });

/** POST /admin/built-sites/:id/rotate-renewal-token */
const handleRotateToken = ownerPost(async (site, _form, _tiers, id) => {
  if (!isProvisioned(site)) return redirectToEdit(id);
  const result = await rotateRenewalToken(
    site,
    `Rotate token push failed for site ${id}`,
  );
  if (result.pushOk) {
    await logActivity(`Rotated renewal token for '${site.name}'`);
  }
  return redirectToEdit(id);
});

/** POST /admin/built-sites/:id/set-renewal-tier */
const handleSetRenewalTier = ownerPost(async (site, form, tiers, id) => {
  const tierEventId = readAllowedTierId(true, tiers)(site, form);
  if (tierEventId === null) return redirectToEdit(id);
  await updateBuiltSiteRenewalState(id, { renewalTierEventId: tierEventId });
  await logActivity(
    `Set renewal tier for '${site.name}' to event #${tierEventId}`,
  );
  return redirectToEdit(id);
});

/** POST /admin/built-sites/:id/bump-deadline */
const handleBumpDeadline = ownerPost(async (site, form, _tiers, id) => {
  const months = readClampedMonths(form);
  const newIso = addMonthsToRenewalDeadline(site, months);
  await syncReadOnlyFrom(site, newIso);
  await logActivity(
    `Admin bumped '${site.name}' deadline by ${months} month(s)`,
  );
  return redirectToEdit(id);
});

/** POST /admin/built-sites/:id/override-deadline */
const handleOverrideDeadline = ownerPost(async (site, form, _tiers, id) => {
  const dateStr = form.getString("date");
  if (!dateStr) return redirectToEdit(id);
  const cutoffIso = `${dateStr}T23:59:59Z`;
  await syncReadOnlyFrom(site, cutoffIso);
  await logActivity(`Admin overrode '${site.name}' deadline to ${cutoffIso}`);
  return redirectToEdit(id);
});

/** POST /admin/built-sites/:id/re-sync-deadline */
const handleReSyncDeadline = ownerPost(async (site, _form, _tiers, id) => {
  if (!site.readOnlyFrom) return redirectToEdit(id);
  const renewalUrl =
    isProvisioned(site) && site.renewalToken
      ? renewalUrlFor(site.renewalToken)
      : undefined;
  await syncReadOnlyFrom(site, site.readOnlyFrom, renewalUrl);
  await logActivity(`Admin re-synced deadline for '${site.name}'`);
  return redirectToEdit(id);
});

/** POST /admin/built-sites/:id/provision-renewal */
const handleProvisionRenewal = ownerPost(async (site, form, tiers, id) => {
  const tierEventId = readAllowedTierId(false, tiers)(site, form);
  if (tierEventId === null) return redirectToEdit(id);
  const months = readClampedMonths(form);
  await provisionSiteRenewal(
    site,
    tierEventId,
    months,
    `Provision push failed for site ${id}`,
  );
  await logActivity(
    `Admin provisioned renewals for '${site.name}' (tier #${tierEventId}, ${months}mo)`,
  );
  return redirectToEdit(id);
});

/** Built site routes */
export const builtSitesRoutes = {
  ...crud.routes,
  // Override the CRUD-provided edit GET with a tier-event-loading variant.
  "GET /admin/built-sites/:id/edit": handleEditGet,
  "POST /admin/built-sites/:id/bump-deadline": handleBumpDeadline,
  "POST /admin/built-sites/:id/override-deadline": handleOverrideDeadline,
  "POST /admin/built-sites/:id/provision-renewal": handleProvisionRenewal,
  "POST /admin/built-sites/:id/re-sync-deadline": handleReSyncDeadline,
  "POST /admin/built-sites/:id/rotate-renewal-token": handleRotateToken,
  "POST /admin/built-sites/:id/set-renewal-tier": handleSetRenewalTier,
};
