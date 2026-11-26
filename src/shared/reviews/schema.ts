// effects: pure
import * as v from "valibot";
import { IsoDateSchema } from "#shared/validation/date-string.ts";

const RequiredTextSchema = v.pipe(v.string(), v.trim(), v.minLength(1));

/** One customer review, read from the reviews markdown file. */
export const ReviewSchema = v.object({
  date: IsoDateSchema,
  name: RequiredTextSchema,
  rating: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5)),
  text: RequiredTextSchema,
  url: v.optional(
    v.pipe(
      v.string(),
      v.url(),
      v.regex(
        /^https?:\/\//i,
        "The review URL must start with http:// or https://",
      ),
    ),
  ),
});

const ReviewListSchema = v.pipe(v.array(ReviewSchema), v.minLength(1));

/** The frontmatter of the one reviews source file. */
export const ReviewsSourceSchema = v.object({
  reviews: ReviewListSchema,
});

/** The validated page data the generated module carries. */
export const ReviewsPageDataSchema = v.object({
  intro: v.string(),
  reviews: ReviewListSchema,
});

export type Review = v.InferOutput<typeof ReviewSchema>;
export type ReviewsPageData = v.InferOutput<typeof ReviewsPageDataSchema>;

/** Newest review first. A review date is a real calendar day, so the ISO text
 *  sorts in date order without parsing it again. */
export const sortReviewsNewest = (reviews: readonly Review[]): Review[] =>
  reviews.toSorted((a, b) => b.date.localeCompare(a.date));
