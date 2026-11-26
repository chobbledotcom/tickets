/** The generated reviews module text. JSON keeps the committed data
 *  independent of any TypeScript formatting rules. */

import type { ReviewsPageData } from "#shared/reviews/schema.ts";

export const renderReviewsJson = (
  source: string,
  page: ReviewsPageData,
): string => `${JSON.stringify({ page, source }, null, 2)}\n`;
