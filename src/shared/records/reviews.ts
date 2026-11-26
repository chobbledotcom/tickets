/** The review record: the row the admin pages and the public page read, and
 *  the one write rule both admin doors share. */

import {
  createReview,
  deleteReview,
  getAllReviews,
  getReviewById,
  updateReview,
} from "#db/reviews.ts";
import { t } from "#i18n";
import { MAX_INPUT_LENGTH, MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { defineNamedRowRecord } from "#shared/rest/named-record.ts";
import { logNameActivity, type RecordShapeOf } from "#shared/rest/record.ts";
import {
  commitCommand,
  deleteAndLog,
  updateIfPresent,
} from "#shared/rest/record-command.ts";
import { errorResult, type Result } from "#shared/result.ts";
import {
  type ReviewInput,
  type ReviewRuleError,
  reviewRule,
} from "#shared/reviews/rule.ts";
import type { Review } from "#shared/reviews/types.ts";

/* jscpd:ignore-start -- static data, not code */
const REVIEW_ERROR_KEYS: Record<ReviewRuleError, string> = {
  dateInvalid: "reviews.error.date_invalid",
  nameRequired: "reviews.error.name_required",
  nameTooLong: "reviews.error.name_too_long",
  ratingInvalid: "reviews.error.rating_invalid",
  textRequired: "reviews.error.text_required",
  textTooLong: "reviews.error.text_too_long",
  urlInvalid: "reviews.error.url_invalid",
  urlRequired: "reviews.error.url_required",
  urlTooLong: "reviews.error.url_too_long",
};
/* jscpd:ignore-end */

const rule = (input: ReviewInput) => {
  const result = reviewRule(input, {
    name: MAX_INPUT_LENGTH,
    text: MAX_TEXTAREA_LENGTH,
  });
  return result.ok ? result : errorResult(t(REVIEW_ERROR_KEYS[result.error]));
};

const logReview = logNameActivity("Review");

const refused = (): string => t("reviews.error.url_taken");

const commitReview =
  (
    action: "created" | "updated",
    write: (input: ReviewInput) => Promise<Result<Review, "urlTaken">>,
  ) =>
  (input: ReviewInput) =>
    commitCommand<Review, ReviewInput, "urlTaken">({
      input,
      log: (row) => logReview(row.name, action),
      message: refused,
      rule,
      stored: null,
      write,
    });

const saveReview = (id: number) =>
  commitReview("updated", (input) => updateReview(id, input));

export const reviewRecord = defineNamedRowRecord<
  RecordShapeOf<Review, ReviewInput>
>()({
  activityName: "Review",
  getAll: getAllReviews,
  load: getReviewById,
  nameLabel: "reviews.field.name",
  rule,
  surface: { deleteDestination: "reviewDelete", list: "siteReviews" },
  write: {
    create: commitReview("created", createReview),
    remove: (id) =>
      deleteAndLog(id, {
        destroy: () => deleteReview(id),
        load: getReviewById,
        log: (row) => logReview(row.name, "deleted"),
      }),
    update: (id, input) =>
      updateIfPresent(
        getReviewById,
        (_row, value) => saveReview(id)(value),
        id,
        input,
      ),
  },
});
