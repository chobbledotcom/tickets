/**
 * The site-page create and edit forms: name, slug, SEO meta, the Hidden
 * checkbox, and markdown content. The shared content-forms factory builds
 * them, and the admin templates render them. The create form asks for the
 * slug too (unlike news, it is typed by hand). The edit form's slug shows
 * the saved page's public link.
 */

import { t } from "#i18n";
import { checkboxField } from "#templates/fields/checkbox-field.ts";
import type { SitePage } from "#types";
import {
  contentFieldValues,
  contentSlugField,
  defineContentForms,
} from "./content-form-fields.ts";

export const { createForm: sitePageForm, editForm: sitePageEditForm } =
  defineContentForms({
    createSlugFields: [contentSlugField()] as const,
    extraFields: [
      checkboxField("hidden", {
        hint: t("site.pages.field.hidden_hint"),
        label: t("site.pages.field.hidden"),
        optionLabel: t("site.pages.field.hidden_label"),
      }),
    ],
    nameLabel: t("site.pages.field.name"),
    publicLinkPath: (slug) => `/page/${slug}`,
  });

/** Snake-case field values for pre-filling the edit form (slug and the Hidden
 * box included). */
export const sitePageToValues = (page: SitePage): Record<string, string> => ({
  ...contentFieldValues(page),
  hidden: page.hidden ? "1" : "",
});
