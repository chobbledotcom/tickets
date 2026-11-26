/** The review editor form: the reviewer, the score, the date, the words, and
 *  the public review address. */

import { t } from "#i18n";
import { defineForm } from "#shared/forms/definition.ts";
import { MAX_INPUT_LENGTH, MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import type { ReviewInput } from "#shared/reviews/rule.ts";
import type { Review } from "#shared/reviews/types.ts";

/* jscpd:ignore-start -- static data, not code */
const RATING_OPTIONS = [
  { label: "1", value: "1" },
  { label: "2", value: "2" },
  { label: "3", value: "3" },
  { label: "4", value: "4" },
  { label: "5", value: "5" },
] as const;
/* jscpd:ignore-end */

export const getReviewForm = () =>
  defineForm({
    fields: [
      {
        autocomplete: "off" as const,
        label: t("reviews.field.name"),
        maxlength: MAX_INPUT_LENGTH,
        name: "name",
        required: true,
        type: "text" as const,
      },
      {
        label: t("reviews.field.rating"),
        name: "rating",
        options: RATING_OPTIONS,
        required: true,
        type: "select" as const,
      },
      {
        label: t("reviews.field.date"),
        name: "date",
        required: true,
        type: "date" as const,
      },
      {
        hint: t("reviews.field.text_hint"),
        label: t("reviews.field.text"),
        markdown: true,
        maxlength: MAX_TEXTAREA_LENGTH,
        name: "text",
        required: true,
        type: "textarea" as const,
      },
      {
        hint: t("reviews.field.url_hint"),
        label: t("reviews.field.url"),
        maxlength: MAX_TEXTAREA_LENGTH,
        name: "url",
        required: true,
        type: "url" as const,
      },
    ] as const,
  });

/** The form's saved values for one review. */
export const reviewFormValues = (review: Review) => ({
  date: review.date,
  name: review.name,
  rating: String(review.rating),
  text: review.text,
  url: review.url,
});

/** The validated form values as the record's write input. */
export const reviewInputFromForm = (values: {
  date: string;
  name: string;
  rating: string;
  text: string;
  url: string;
}): ReviewInput => ({
  date: values.date,
  name: values.name.trim(),
  rating: Number(values.rating),
  text: values.text.trim(),
  url: values.url.trim(),
});
