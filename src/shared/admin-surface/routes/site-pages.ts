import { route } from "#shared/admin-surface/definitions.ts";

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
  route(
    "postSitePagesByIdItemsByItemTypeByItemIdMoveDown",
    "sitePages",
    "POST",
    "/admin/site/pages/:id/items/:itemType/:itemId/move-down",
  ),
  route(
    "postSitePagesByIdItemsByItemTypeByItemIdMoveUp",
    "sitePages",
    "POST",
    "/admin/site/pages/:id/items/:itemType/:itemId/move-up",
  ),
  route(
    "postSitePagesByIdItemsByItemTypeByItemIdRemove",
    "sitePages",
    "POST",
    "/admin/site/pages/:id/items/:itemType/:itemId/remove",
  ),
  route(
    "postSitePagesByIdMoveDown",
    "sitePages",
    "POST",
    "/admin/site/pages/:id/move-down",
  ),
  route(
    "postSitePagesByIdMoveUp",
    "sitePages",
    "POST",
    "/admin/site/pages/:id/move-up",
  ),
] as const;
