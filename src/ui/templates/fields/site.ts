/** Site page editor form fields (home, contact, order intro, reviews). */

import { t } from "#i18n";
import { defineForm } from "#shared/forms/definition.ts";
import { MAX_INPUT_LENGTH, MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { formattingHint } from "#templates/components/formatting-hint.ts";

/** A markdown text box for one site page, worded by the catalog keys under
 * `prefix` (`_label`, `_hint`, `_placeholder`). */
const siteTextarea = <Name extends string>(field: Name, prefix: string) =>
  ({
    hintHtml: `${t(`${prefix}_hint`, { max: `${MAX_TEXTAREA_LENGTH}` })} ${formattingHint()}`,
    id: field,
    label: t(`${prefix}_label`),
    markdown: true,
    maxlength: MAX_TEXTAREA_LENGTH,
    name: field,
    placeholder: t(`${prefix}_placeholder`),
    type: "textarea" as const,
  }) as const;

/** One site editor page whose only field is one markdown text box. */
const singleTextForm = <const Name extends string>(
  field: Name,
  prefix: string,
) => defineForm({ fields: [siteTextarea(field, prefix)] as const });

export const siteHomeForm = defineForm({
  fields: [
    {
      autocomplete: "off" as const,
      hint: t("site.home.title_hint", { max: `${MAX_INPUT_LENGTH}` }),
      id: "website_title",
      label: t("site.home.title_label"),
      maxlength: MAX_INPUT_LENGTH,
      name: "websiteTitle",
      type: "text" as const,
    },
    siteTextarea("homepageText", "site.home.text"),
  ] as const,
});

export const siteContactForm = singleTextForm(
  "contactPageText",
  "site.contact.text",
);

export const siteOrderForm = singleTextForm(
  "orderIntroText",
  "site.order.text",
);

export const siteReviewsForm = singleTextForm(
  "reviewsMarkdown",
  "site.reviews.text",
);
