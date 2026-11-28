/** Public `/reviews` — customer reviews in one masonry page.
 *
 *  The route runs behind the public-site gate. When the Reviews feature is off,
 *  the page answers 404. A direct link then never shows a page the owner hid. A
 *  site with no saved reviews answers 404 too. The nav link and the sitemap
 *  entry appear only while the page has something to show. */

import { getAllReviews } from "#db/reviews.ts";
import { settings } from "#db/settings.ts";
import { htmlResponse, notFoundResponse } from "#routes/response.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import { requirePublicSite } from "#shared/public-site.ts";
import { reviewsPage } from "#templates/public/reviews.tsx";
import { publicNavProps } from "./site-nav.ts";

const handleReviews = async (): Promise<Response> => {
  if (!settings.reviewsEnabled) return notFoundResponse();
  const reviews = await getAllReviews();
  if (reviews.length === 0) return notFoundResponse();
  return htmlResponse(
    reviewsPage(
      reviews,
      await publicNavProps(null),
      settings.websiteTitle,
      settings.reviewsIntroText || null,
    ),
  );
};

/** Route `/reviews` requests (public-site gate first, then the page switch). */
export const routeReviews = createRouter(
  defineRoutes({
    "GET /reviews": () => requirePublicSite(handleReviews),
  }),
);
