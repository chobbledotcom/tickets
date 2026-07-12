/**
 * The shared page-fields form (name, slug, SEO meta, markdown content), used by
 * both the create and edit routes and rendered by the admin templates.
 */

import { t } from "#i18n";
import { defineForm } from "#shared/forms/definition.ts";
import type { SitePage } from "#shared/types.ts";
import {
  contentMetaValues,
  contentNameField,
  contentSlugField,
  markdownContentField,
  seoMetaFields,
} from "./content-form-fields.ts";

const nameField = contentNameField(t("site.pages.field.name"));

/** The fields after the slug, shared by the create and edit forms. */
const trailingFields = [...seoMetaFields(), markdownContentField()] as const;

/** The create form: the slug has no public link (the page has no live page
 * yet, so a restored-after-error slug must not render a link that 404s). */
export const sitePageForm = defineForm({
  fields: [nameField, contentSlugField(), ...trailingFields] as const,
  id: "sitePage",
});

/** The edit form: the same fields, but the slug shows the saved page's public
 * link beneath it. */
export const sitePageEditForm = defineForm({
  fields: [
    nameField,
    contentSlugField((slug) => `/page/${slug}`),
    ...trailingFields,
  ] as const,
  id: "sitePageEdit",
});

/** Snake-case field values for pre-filling the edit form. */
export const pageToValues = (page: SitePage): Record<string, string> => ({
  ...contentMetaValues(page),
  slug: page.slug,
});
