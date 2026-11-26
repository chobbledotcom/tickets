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

const wideReviewField = <
  const Name extends string,
  const Section extends "details" | "link",
  const Type extends "textarea" | "url",
>(config: {
  hint: string;
  label: string;
  name: Name;
  section: Section;
  type: Type;
}) => ({
  hint: config.hint,
  hintFirst: true as const,
  label: config.label,
  maxlength: MAX_TEXTAREA_LENGTH,
  name: config.name,
  required: true as const,
  section: config.section,
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
        name: "rating",
        options: RATING_OPTIONS,
        required: true,
        section: "details" as const,
        type: "select" as const,
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
          section: "details" as const,
          type: "textarea" as const,
        }),
        markdown: true,
      },
      wideReviewField({
        hint: t("reviews.field.url_hint"),
        label: t("reviews.field.url"),
        name: "url",
        section: "link" as const,
        type: "url" as const,
      }),
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
