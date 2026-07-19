import { moveRoutes, route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route(
    "getSitePagesByIdDelete",
    "sitePages",
    "GET",
    "/admin/site/pages/:id/delete",
  ),
  route(
    "postSitePagesByIdDelete",
    "sitePages",
    "POST",
    "/admin/site/pages/:id/delete",
  ),
  route("getSitePages", "sitePages", "GET", "/admin/site/pages"),
  route("getSitePagesById", "sitePages", "GET", "/admin/site/pages/:id"),
  route(
    "getSitePagesByIdByTab",
    "sitePages",
    "GET",
    "/admin/site/pages/:id/:tab",
  ),
  route("getSitePagesNew", "sitePages", "GET", "/admin/site/pages/new"),
  route("postSitePages", "sitePages", "POST", "/admin/site/pages"),
  route(
    "postSitePagesByIdEdit",
    "sitePages",
    "POST",
    "/admin/site/pages/:id/edit",
  ),
  route(
    "postSitePagesByIdImages",
    "sitePages",
    "POST",
    "/admin/site/pages/:id/images",
  ),
  route(
    "postSitePagesByIdImagesUpload",
    "sitePages",
    "POST",
    "/admin/site/pages/:id/images/upload",
  ),
  route(
    "postSitePagesByIdItems",
    "sitePages",
    "POST",
    "/admin/site/pages/:id/items",
  ),
  ...moveRoutes(
    "postSitePagesByIdItemsByItemTypeByItemId",
    "sitePages",
    "/admin/site/pages/:id/items/:itemType/:itemId",
  ),
  route(
    "postSitePagesByIdItemsByItemTypeByItemIdRemove",
    "sitePages",
    "POST",
    "/admin/site/pages/:id/items/:itemType/:itemId/remove",
  ),
  ...moveRoutes("postSitePagesById", "sitePages", "/admin/site/pages/:id"),
] as const;
