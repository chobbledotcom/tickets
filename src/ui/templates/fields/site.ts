/** Site page editor form fields (home, contact, order intro). */

import { MAX_WEBSITE_TITLE_LENGTH } from "#db/settings/constants.ts";
import { t } from "#i18n";
import { defineForm } from "#shared/forms/definition.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
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

export const siteHomeForm = defineForm({
  fields: [
    {
      autocomplete: "off" as const,
      hint: t("site.home.title_hint", { max: `${MAX_WEBSITE_TITLE_LENGTH}` }),
      id: "website_title",
      label: t("site.home.title_label"),
      maxlength: MAX_WEBSITE_TITLE_LENGTH,
      name: "website_title",
      type: "text" as const,
    },
    siteTextarea("homepage_text", "site.home.text"),
  ] as const,
});

export const siteContactForm = defineForm({
  fields: [siteTextarea("contact_page_text", "site.contact.text")] as const,
});

export const siteOrderForm = defineForm({
  fields: [siteTextarea("order_intro_text", "site.order.text")] as const,
});
