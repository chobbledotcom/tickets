/**
 * The site-page create and edit forms (name, slug, SEO meta, markdown
 * content), built by the shared content-forms factory and rendered by the
 * admin templates. The create form asks for the slug too (unlike news, it is
 * typed by hand); the edit form's slug shows the saved page's public link.
 */

import { t } from "#i18n";
import { contentSlugField, defineContentForms } from "./content-form-fields.ts";

export const { createForm: sitePageForm, editForm: sitePageEditForm } =
  defineContentForms({
    createSlugFields: [contentSlugField()] as const,
    extraFields: [],
    id: "sitePage",
    nameLabel: t("site.pages.field.name"),
    publicLinkPath: (slug) => `/page/${slug}`,
  });
