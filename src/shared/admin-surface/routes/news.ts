import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route("getSiteNewsByIdDelete", "news", "GET", "/admin/site/news/:id/delete"),
  route(
    "postSiteNewsByIdDelete",
    "news",
    "POST",
    "/admin/site/news/:id/delete",
  ),
  route("getSiteNews", "news", "GET", "/admin/site/news"),
  route("getSiteNewsById", "news", "GET", "/admin/site/news/:id"),
  route("getSiteNewsByIdByTab", "news", "GET", "/admin/site/news/:id/:tab"),
  route("getSiteNewsNew", "news", "GET", "/admin/site/news/new"),
  route("postSiteNews", "news", "POST", "/admin/site/news"),
  route("postSiteNewsByIdEdit", "news", "POST", "/admin/site/news/:id/edit"),
  route(
    "postSiteNewsByIdImages",
    "news",
    "POST",
    "/admin/site/news/:id/images",
  ),
  route(
    "postSiteNewsByIdImagesUpload",
    "news",
    "POST",
    "/admin/site/news/:id/images/upload",
  ),
] as const;
