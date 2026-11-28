/** The public reviews page: the shared public shell around the reviews body. */

import { t } from "#i18n";
import { formatMonthYearShortLabel } from "#shared/date-labels.ts";
import type { Review } from "#shared/reviews/types.ts";
import { type ReviewsLabels, reviewsBody } from "./reviews-body.tsx";
import {
  MarkdownProse,
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
  reviews: readonly Review[],
  nav: PublicNavProps,
  websiteTitle: string,
  introText?: string | null,
): string =>
  publicPage(
    titleWithSiteName(t("nav.public.reviews"), websiteTitle),
    websiteTitle,
    nav,
  )(
    <>
      {introText ? <MarkdownProse markdown={introText} /> : null}
      {reviewsBody(reviews, reviewLabels())}
    </>,
  );
