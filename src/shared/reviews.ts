// effects: pure
import * as v from "valibot";
import {
  type ReviewsPageData,
  ReviewsPageDataSchema,
} from "#shared/reviews/schema.ts";
import generated from "./reviews.generated.json" with { type: "json" };

const GeneratedReviewsSchema = v.object({
  page: ReviewsPageDataSchema,
  source: v.string(),
});

const generatedReviews = v.parse(GeneratedReviewsSchema, generated);

/** The reviews markdown the repository ships. An operator who has not saved
 *  an edit sees this as the page, and as the editor's starting text. */
export const REVIEWS_SOURCE: string = generatedReviews.source;

/** The page data for {@link REVIEWS_SOURCE}. The public page uses it without
 *  parsing the markdown again. */
export const REVIEWS_PAGE: ReviewsPageData = generatedReviews.page;
