/**
 * Public `/page/:slug` — a user-created content page.
 *
 * Gate order matters: `requirePublicSite` runs FIRST, before any slug lookup,
 * so a disabled site redirects to the admin login without leaking whether a
 * given slug exists. Then the page resolves by its blind index (one narrow
 * decrypted read) and renders with the recursive public nav anchored on it —
 * the deepest submenu level of the nav model IS the page's own children (N7),
 * so one pure computation feeds both the nav and the body item list.
 */

import { hmacHash } from "#crypto/hashing.ts";
import { getImagesForItem } from "#db/images.ts";
import { settings } from "#db/settings.ts";
/* jscpd:ignore-start -- imports */
import { getSitePageBySlugIndex } from "#db/site-pages.ts";
import { htmlResponse, notFoundResponse } from "#routes/response.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import { requirePublicSite } from "#shared/public-site.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
/* jscpd:ignore-end */
import { sitePageItemTargets } from "#shared/site-pages/target.ts";
import { sitePagePage } from "#templates/public/site-page.tsx";
import { publicNavProps } from "./site-nav.ts";

/** How a resolved content item is turned into its page markup. */
type ContentPageRender<T> = (
  item: T,
  images: Awaited<ReturnType<typeof getImagesForItem>>,
  nav: Awaited<ReturnType<typeof publicNavProps>>,
  websiteTitle: string,
) => string;

/**
 * 404 when the item was not found; otherwise load its images and the public nav
 * together and render the page with the site title. Shared by the single
 * content page and the single news post, which differ only in the image kind,
 * the nav anchor, and the template.
 */
export const renderContentPage = async <T extends { id: number }>(
  item: T | null,
  imageKind: Parameters<typeof getImagesForItem>[0],
  navTargetFor: (item: T) => Parameters<typeof publicNavProps>[0],
  render: ContentPageRender<T>,
): Promise<Response> => {
  if (!item) return notFoundResponse();
  const [images, nav] = await Promise.all([
    getImagesForItem(imageKind, item.id),
    publicNavProps(navTargetFor(item)),
  ]);
  return htmlResponse(render(item, images, nav, settings.websiteTitle));
};

/** A public GET route for a slugged content page: the public-site gate runs
 * FIRST (so a disabled site never leaks whether the slug exists), then the
 * slug handler. Shared by `/page/:slug` and `/news/:slug`. */
export const publicSlugRoute =
  (
    handle: (slug: string) => Promise<Response>,
  ): ResponseHandler<[request: Request, params: { slug: string }]> =>
  (_request, { slug }) =>
    requirePublicSite(() => handle(slug));

const handleSitePage = async (slug: string): Promise<Response> => {
  const slugIndex = await hmacHash(slug);
  const page = await getSitePageBySlugIndex(slugIndex);
  return renderContentPage(
    page,
    "page",
    (found) =>
      sitePageItemTargets.key(sitePageItemTargets.of("page")(found.id)),
    sitePagePage,
  );
};

/** Route `/page/*` requests (public-site gate first, then slug resolution). */
export const routeSitePage = createRouter(
  defineRoutes({
    "GET /page/:slug": publicSlugRoute(handleSitePage),
  }),
);
