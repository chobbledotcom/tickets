/**
 * Admin built site management routes - owner only
 */

import { lazyRef } from "#fp";
import { createOwnerCrudHandlers } from "#routes/admin/owner-crud.ts";
import { requireCsrfForm } from "#routes/csrf.ts";
import { htmlResponse, redirectResponse } from "#routes/response.ts";
import type { RouteParams } from "#routes/router.ts";
import { addMonthsIso } from "#shared/dates.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import type { BuiltSite, BuiltSiteFormInput } from "#shared/db/built-sites.ts";
import {
  builtSitesCrudTable,
  getAllBuiltSites,
  getBuiltSiteRenewalToken,
  updateBuiltSiteRenewalState,
} from "#shared/db/built-sites.ts";
import { getAllEvents } from "#shared/db/events.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { nowIso, nowMs } from "#shared/now.ts";
import { sendNtfyError } from "#shared/ntfy.ts";
import { isProvisioned } from "#shared/renewal-helpers.ts";
import { defineNamedResource } from "#shared/rest/resource.ts";
import {
  generateRenewalToken,
  pushReadOnlyFrom,
  renewalUrlFor,
} from "#shared/site-assignment.ts";
import {
  adminBuiltSiteDeletePage,
  adminBuiltSiteEditPage,
  adminBuiltSiteNewPage,
  adminBuiltSitesPage,
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

/** Get qualifying tier events for the renewal dropdown */
const getQualifyingTierEvents = async (): Promise<
  { id: number; name: string; unit_price: number; months_per_unit: number }[]
> => {
  const events = await getAllEvents();
  return events
    .filter(
      (e) => e.purchase_only && e.hidden && e.months_per_unit > 0 && e.active,
    )
    .map((e) => ({
      id: e.id,
      months_per_unit: e.months_per_unit,
      name: e.name,
      unit_price: e.unit_price,
    }));
};

const crud = createOwnerCrudHandlers({
  getAll: getAllBuiltSites,
  getName: (s) => s.name,
  listPath: "/admin/built-sites",
  renderDelete: adminBuiltSiteDeletePage,
  renderEdit: (site, session, error) =>
    adminBuiltSiteEditPage(site, session, getQualifyingTierEventsSync(), error),
  renderList: adminBuiltSitesPage,
  renderNew: adminBuiltSiteNewPage,
  resource: builtSitesResource,
  singular: "Built site",
});

type TierEvent = {
  id: number;
  name: string;
  unit_price: number;
  months_per_unit: number;
};

/** Synchronous cache for qualifying tier events (loaded per-request) */
const [getTierEventsCache, setTierEventsCache] = lazyRef<TierEvent[] | null>(
  () => null,
);
const getQualifyingTierEventsSync = () => getTierEventsCache() ?? [];

/** Owner-gated POST handler wrapper */
const ownerPost =
  (
    handler: (
      site: BuiltSite,
      form: { getString: (key: string) => string },
      requestId: number,
    ) => Promise<Response>,
  ) =>
  async (request: Request, params: RouteParams): Promise<Response> => {
    setTierEventsCache(await getQualifyingTierEvents());
    const id = Number(params.id);
    if (!id) return redirectResponse("/admin/built-sites");
    const site = await builtSitesCrudTable.findById(id);
    if (!site) return redirectResponse("/admin/built-sites");
    const csrfResult = await requireCsrfForm(request, () =>
      htmlResponse(
        adminBuiltSiteEditPage(
          site,
          { adminLevel: "owner" },
          getQualifyingTierEventsSync(),
          "CSRF token invalid",
        ),
        403,
      ),
    );
    if (!csrfResult.ok) return csrfResult.response;
    return handler(site, csrfResult.form, id);
  };

/** POST /admin/built-sites/:id/rotate-renewal-token */
const handleRotateToken = ownerPost(async (site, _form, id) => {
  if (!isProvisioned(site)) {
    return redirectResponse(`/admin/built-sites/${id}/edit`);
  }
  const { token, index } = await generateRenewalToken();
  const newUrl = renewalUrlFor(token);
  const pushResult = await pushReadOnlyFrom(
    site,
    site.readOnlyFrom || nowIso(),
    newUrl,
  );
  if (pushResult.ok) {
    await updateBuiltSiteRenewalState(id, {
      renewalToken: token,
      renewalTokenIndex: index,
    });
    await logActivity(`Rotated renewal token for '${site.name}'`);
  } else {
    logError({
      code: ErrorCode.CDN_REQUEST,
      detail: `Rotate token push failed for site ${id}: ${pushResult.error}`,
    });
  }
  return redirectResponse(`/admin/built-sites/${id}/edit`);
});

/** POST /admin/built-sites/:id/set-renewal-tier */
const handleSetRenewalTier = ownerPost(async (site, form, id) => {
  if (!isProvisioned(site)) {
    return redirectResponse(`/admin/built-sites/${id}/edit`);
  }
  const tierEventId = Number(form.getString("tier_event_id"));
  const tierEvents = getQualifyingTierEventsSync();
  if (!tierEvents.some((te) => te.id === tierEventId)) {
    return redirectResponse(`/admin/built-sites/${id}/edit`);
  }
  await updateBuiltSiteRenewalState(id, { renewalTierEventId: tierEventId });
  await logActivity(
    `Set renewal tier for '${site.name}' to event #${tierEventId}`,
  );
  return redirectResponse(`/admin/built-sites/${id}/edit`);
});

/** POST /admin/built-sites/:id/bump-deadline */
const handleBumpDeadline = ownerPost(async (site, form, id) => {
  let months = Number.parseInt(form.getString("months") || "1", 10);
  if (!Number.isFinite(months) || months < 1) months = 1;
  if (months > 120) months = 120;
  const base =
    site.readOnlyFrom && Date.parse(site.readOnlyFrom) > 0
      ? Math.max(nowMs(), Date.parse(site.readOnlyFrom))
      : nowMs();
  const newIso = addMonthsIso(new Date(base).toISOString(), months);
  await pushReadOnlyFrom(site, newIso);
  await logActivity(
    `Admin bumped '${site.name}' deadline by ${months} month(s)`,
  );
  return redirectResponse(`/admin/built-sites/${id}/edit`);
});

/** POST /admin/built-sites/:id/override-deadline */
const handleOverrideDeadline = ownerPost(async (site, form, id) => {
  const dateStr = form.getString("date");
  if (!dateStr) return redirectResponse(`/admin/built-sites/${id}/edit`);
  const cutoffIso = `${dateStr}T23:59:59Z`;
  await pushReadOnlyFrom(site, cutoffIso);
  await logActivity(`Admin overrode '${site.name}' deadline to ${cutoffIso}`);
  return redirectResponse(`/admin/built-sites/${id}/edit`);
});

/** POST /admin/built-sites/:id/re-sync-deadline */
const handleReSyncDeadline = ownerPost(async (site, _form, id) => {
  if (!site.readOnlyFrom) {
    return redirectResponse(`/admin/built-sites/${id}/edit`);
  }
  const renewalUrl = isProvisioned(site)
    ? renewalUrlFor((await getBuiltSiteRenewalToken(site)) ?? "")
    : undefined;
  await pushReadOnlyFrom(site, site.readOnlyFrom, renewalUrl);
  await logActivity(`Admin re-synced deadline for '${site.name}'`);
  return redirectResponse(`/admin/built-sites/${id}/edit`);
});

/** POST /admin/built-sites/:id/provision-renewal */
const handleProvisionRenewal = ownerPost(async (site, form, id) => {
  if (isProvisioned(site)) {
    return redirectResponse(`/admin/built-sites/${id}/edit`);
  }
  const tierEventId = Number(form.getString("tier_event_id"));
  const tierEvents = getQualifyingTierEventsSync();
  if (!tierEvents.some((te) => te.id === tierEventId)) {
    return redirectResponse(`/admin/built-sites/${id}/edit`);
  }
  let months = Number.parseInt(form.getString("months") || "1", 10);
  if (!Number.isFinite(months) || months < 1) months = 1;

  const { token, index } = await generateRenewalToken();
  const cutoff = addMonthsIso(nowIso(), months);
  const renewalUrl = renewalUrlFor(token);

  const pushResult = await pushReadOnlyFrom(site, cutoff, renewalUrl);
  if (pushResult.ok) {
    await updateBuiltSiteRenewalState(id, {
      readOnlyFrom: cutoff,
      renewalTierEventId: tierEventId,
      renewalToken: token,
      renewalTokenIndex: index,
    });
  } else {
    logError({
      code: ErrorCode.CDN_REQUEST,
      detail: `Provision push failed for site ${id}: ${pushResult.error}`,
    });
    sendNtfyError("CDN_REQUEST");
    await updateBuiltSiteRenewalState(id, {
      renewalTierEventId: tierEventId,
      renewalToken: token,
      renewalTokenIndex: index,
    });
  }

  await logActivity(
    `Admin provisioned renewals for '${site.name}' (tier #${tierEventId}, ${months}mo)`,
  );
  return redirectResponse(`/admin/built-sites/${id}/edit`);
});

/** Built site routes */
export const builtSitesRoutes = {
  ...crud.routes,
  "POST /admin/built-sites/:id/bump-deadline": handleBumpDeadline,
  "POST /admin/built-sites/:id/override-deadline": handleOverrideDeadline,
  "POST /admin/built-sites/:id/provision-renewal": handleProvisionRenewal,
  "POST /admin/built-sites/:id/re-sync-deadline": handleReSyncDeadline,
  "POST /admin/built-sites/:id/rotate-renewal-token": handleRotateToken,
  "POST /admin/built-sites/:id/set-renewal-tier": handleSetRenewalTier,
};
