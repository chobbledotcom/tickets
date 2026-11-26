// effects: pure
/** Read one reviews markdown file into the page data.
 *
 *  The frontmatter holds the reviews. The body holds the page introduction.
 *  Every malformed value names the file and the field that failed. Both the
 *  public page and the admin editor use this parser, so a saved file and a
 *  served file always mean the same thing. */

import { parse as parseYaml } from "@std/yaml";
import * as v from "valibot";
import { errorMessage } from "#shared/error-message.ts";
import { markdownFrontmatter } from "#shared/frontmatter.ts";
import {
  type ReviewsPageData,
  ReviewsSourceSchema,
  sortReviewsNewest,
} from "#shared/reviews/schema.ts";

export const parseReviewsSource = (
  filename: string,
  text: string,
): ReviewsPageData => {
  const parts = markdownFrontmatter(text);
  if (parts === null) {
    throw new Error(`${filename}: no frontmatter block`);
  }
  const document = (() => {
    try {
      return parseYaml(parts.frontmatter);
    } catch (error) {
      throw new Error(
        `${filename}: unparseable frontmatter: ${errorMessage(error)}`,
      );
    }
  })();
  const parsed = v.safeParse(ReviewsSourceSchema, document);
  if (!parsed.success) {
    throw new Error(`${filename}: ${v.summarize(parsed.issues)}`);
  }
  return {
    intro: parts.body.trim(),
    reviews: sortReviewsNewest(parsed.output.reviews),
  };
};
