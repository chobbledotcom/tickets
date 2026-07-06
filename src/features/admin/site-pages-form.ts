/**
 * The shared page-fields form (name, slug, SEO meta, markdown content), used by
 * both the create and edit routes and rendered by the admin templates.
 */

import { t } from "#i18n";
import { defineForm } from "#shared/forms.tsx";
import { normalizeSlug, validateSlug } from "#shared/slug.ts";
import type { SitePage } from "#shared/types.ts";
import {
  contentMetaValues,
  contentNameField,
  markdownContentField,
  seoMetaFields,
} from "./content-form-fields.ts";

export const sitePageForm = defineForm({
  fields: [
    contentNameField(t("site.pages.field.name")),
    {
      label: t("common.slug"),
      name: "slug",
      pattern: "[a-z0-9_-]+",
      required: true,
      title: t("fields.listing.slug_title"),
      type: "text" as const,
      validate: (value: string) => validateSlug(normalizeSlug(value)),
    },
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
