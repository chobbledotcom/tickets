/**
 * Public `/page/:slug` — a user-created content page (pages.md).
 *
 * Gate order matters: `requirePublicSite` runs FIRST, before any slug lookup,
 * so a disabled site redirects to the admin login without leaking whether a
 * given slug exists. Then the page resolves by its blind index (one narrow
 * decrypted read) and renders with the recursive public nav anchored on it —
 * the deepest submenu level of the nav model IS the page's own children (N7),
 * so one pure computation feeds both the nav and the body item list.
 */

import { htmlResponse, notFoundResponse } from "#routes/response.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import { settings } from "#shared/db/settings.ts";
import {
  computeSitePageSlugIndex,
  getSitePageBySlugIndex,
} from "#shared/db/site-pages.ts";
import { targetKey } from "#shared/site-pages/core.ts";
import { sitePagePage } from "#templates/public.tsx";
import { requirePublicSite } from "./pages.ts";
import { publicNavProps } from "./site-nav.ts";

const handleSitePage = async (slug: string): Promise<Response> => {
  const slugIndex = await computeSitePageSlugIndex(slug);
  const page = await getSitePageBySlugIndex(slugIndex);
  if (!page) return notFoundResponse();
  const nav = await publicNavProps(targetKey("page", page.id));
  return htmlResponse(sitePagePage(page, nav, settings.websiteTitle));
};

/** Route `/page/*` requests (public-site gate first, then slug resolution). */
export const routeSitePage = createRouter(
  defineRoutes({
    "GET /page/:slug": (_request, { slug }: { slug: string }) =>
      requirePublicSite(() => handleSitePage(slug)),
  }),
);
