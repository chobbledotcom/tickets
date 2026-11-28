/** The review editor form: the reviewer, the optional score, the date, the words,
 *  and the optional public review address. */

import { t } from "#i18n";
import { defineForm } from "#shared/forms/definition.ts";
import { MAX_INPUT_LENGTH, MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import type { ReviewInput } from "#shared/reviews/rule.ts";
import type { Review } from "#shared/reviews/types.ts";

const wideReviewField = <
  const Name extends string,
  const Type extends "textarea" | "url",
>(config: {
  hint: string;
  label: string;
  name: Name;
  required: boolean;
  type: Type;
}) => ({
  hint: config.hint,
  hintFirst: true as const,
  label: config.label,
  maxlength: MAX_TEXTAREA_LENGTH,
  name: config.name,
  required: config.required,
  section: "details" as const,
  type: config.type,
});

export const getReviewForm = () =>
  defineForm({
    fields: [
      {
        autocomplete: "off" as const,
        label: t("reviews.field.name"),
        maxlength: MAX_INPUT_LENGTH,
        name: "name",
        required: true,
        section: "details" as const,
        type: "text" as const,
      },
      {
        label: t("reviews.field.rating"),
        max: 5,
        min: 1,
        name: "rating",
        section: "details" as const,
        type: "number" as const,
      },
      {
        label: t("reviews.field.date"),
        name: "date",
        required: true,
        section: "details" as const,
        type: "date" as const,
      },
      {
        ...wideReviewField({
          hint: t("reviews.field.text_hint"),
          label: t("reviews.field.text"),
          name: "text",
          required: true,
          type: "textarea" as const,
        }),
        markdown: true,
      },
      wideReviewField({
        hint: t("reviews.field.url_hint"),
        label: t("reviews.field.url"),
        name: "url",
        required: false,
        type: "url" as const,
      }),
    ] as const,
  });

/** The form's saved values for one review. */
export const reviewFormValues = (review: Review) => ({
  date: review.date,
  name: review.name,
  rating: review.rating,
  text: review.text,
  url: review.url ?? "",
});

/** The validated form values as the record's write input. */
export const reviewInputFromForm = (
  values: Omit<ReviewInput, "url"> & { url: string },
): ReviewInput => ({
  date: values.date,
  name: values.name.trim(),
  rating: values.rating,
  text: values.text.trim(),
  url: values.url.trim() === "" ? null : values.url.trim(),
});
