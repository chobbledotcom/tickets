/** Public `/reviews` — customer reviews in one masonry page.
 *
 *  The route runs behind the public-site gate. When the Reviews feature is off
 *  the page answers 404, so a direct link never shows a page the owner hid. The
 *  generated data always holds at least one review, so the nav link and the
 *  sitemap entry appear exactly when the feature is on. */

import { settings } from "#db/settings.ts";
import { htmlResponse, notFoundResponse } from "#routes/response.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import { requirePublicSite } from "#shared/public-site.ts";
import { parseReviewsSource } from "#shared/reviews/parse.ts";
import { REVIEWS_PAGE } from "#shared/reviews.ts";
import { reviewsPage } from "#templates/public/reviews.tsx";
import { publicNavProps } from "./site-nav.ts";

const handleReviews = async (): Promise<Response> => {
  if (!settings.features.reviews) return notFoundResponse();
  const page =
    settings.reviewsMarkdown === ""
      ? REVIEWS_PAGE
      : parseReviewsSource("Reviews file", settings.reviewsMarkdown);
  return htmlResponse(
    reviewsPage(page, await publicNavProps(null), settings.websiteTitle),
  );
};

/** Route `/reviews` requests (public-site gate first, then the feature gate). */
export const routeReviews = createRouter(
  defineRoutes({
    "GET /reviews": () => requirePublicSite(handleReviews),
  }),
);
