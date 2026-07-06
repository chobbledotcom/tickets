/**
 * The shared page-fields form (name, slug, SEO meta, markdown content), used by
 * both the create and edit routes and rendered by the admin templates.
 */

import { t } from "#i18n";
import { defineForm } from "#shared/forms.tsx";
import type { SitePage } from "#shared/types.ts";
import {
  contentMetaValues,
  contentNameField,
  contentSlugField,
  markdownContentField,
  seoMetaFields,
} from "./content-form-fields.ts";

export const sitePageForm = defineForm({
  fields: [
    contentNameField(t("site.pages.field.name")),
    // The saved slug's public page (only shown once the page has a slug, so
    // the "new" form renders no link until one is entered).
    contentSlugField((slug) => `/page/${slug}`),
    ...seoMetaFields(),
    markdownContentField(),
  ] as const,
  id: "sitePage",
});

/** Snake-case field values for pre-filling the edit form. */
export const pageToValues = (page: SitePage): Record<string, string> => ({
  ...contentMetaValues(page),
  slug: page.slug,
});
