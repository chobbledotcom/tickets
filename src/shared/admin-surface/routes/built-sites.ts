import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route(
    "getBuiltSitesByIdDelete",
    "builtSites",
    "GET",
    "/admin/built-sites/:id/delete",
  ),
  route(
    "postBuiltSitesByIdDelete",
    "builtSites",
    "POST",
    "/admin/built-sites/:id/delete",
  ),
  route("getBuiltSites", "builtSites", "GET", "/admin/built-sites"),
  route("getBuiltSitesNew", "builtSites", "GET", "/admin/built-sites/new"),
  route("postBuiltSites", "builtSites", "POST", "/admin/built-sites"),
  route("getBuiltSitesById", "builtSites", "GET", "/admin/built-sites/:id"),
  route(
    "getBuiltSitesByIdByTab",
    "builtSites",
    "GET",
    "/admin/built-sites/:id/:tab",
  ),
  route(
    "postBuiltSitesByIdEdit",
    "builtSites",
    "POST",
    "/admin/built-sites/:id/edit",
  ),
  route(
    "postBuiltSitesByIdAddSecrets",
    "builtSites",
    "POST",
    "/admin/built-sites/:id/add-secrets",
  ),
  route(
    "postBuiltSitesByIdBumpDeadline",
    "builtSites",
    "POST",
    "/admin/built-sites/:id/bump-deadline",
  ),
  route(
    "postBuiltSitesByIdOverrideDeadline",
    "builtSites",
    "POST",
    "/admin/built-sites/:id/override-deadline",
  ),
  route(
    "postBuiltSitesByIdProvisionRenewal",
    "builtSites",
    "POST",
    "/admin/built-sites/:id/provision-renewal",
  ),
  route(
    "postBuiltSitesByIdReSyncDeadline",
    "builtSites",
    "POST",
    "/admin/built-sites/:id/re-sync-deadline",
  ),
  route(
    "postBuiltSitesByIdRotateRenewalToken",
    "builtSites",
    "POST",
    "/admin/built-sites/:id/rotate-renewal-token",
  ),
  route(
    "postBuiltSitesByIdUpdate",
    "builtSites",
    "POST",
    "/admin/built-sites/:id/update",
  ),
] as const;
