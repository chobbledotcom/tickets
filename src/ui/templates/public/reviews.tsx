/** The public reviews page: the shared public shell around the reviews body. */

import { t } from "#i18n";
import { formatMonthYearShortLabel } from "#shared/date-labels.ts";
import type { ReviewsPageData } from "#shared/reviews/schema.ts";
import { type ReviewsLabels, reviewsBody } from "./reviews-body.tsx";
import {
  type PublicNavProps,
  publicPage,
  titleWithSiteName,
} from "./shared.tsx";

const reviewLabels = (): ReviewsLabels => ({
  date: formatMonthYearShortLabel,
  rating: (rating: number) => t("common.review_rating", { rating }),
  viewOnGoogle: t("common.view_on_google"),
  viewReview: t("common.view_review"),
});

export const reviewsPage = (
  page: ReviewsPageData,
  nav: PublicNavProps,
  websiteTitle: string,
): string =>
  publicPage(
    titleWithSiteName(t("nav.public.reviews"), websiteTitle),
    websiteTitle,
    nav,
  )(reviewsBody(page, reviewLabels()));
