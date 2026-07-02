/**
 * The shared page-fields form (name, slug, SEO meta, markdown content), used by
 * both the create and edit routes and rendered by the admin templates.
 */

import { t } from "#i18n";
import { defineForm } from "#shared/forms.tsx";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { normalizeSlug, validateSlug } from "#shared/slug.ts";
import type { SitePage } from "#shared/types.ts";
import { FORMATTING_HINT } from "#templates/fields.ts";

const MAX_NAME = 128;
const MAX_META_TITLE = 64;
const MAX_META_DESCRIPTION = 160;

export const sitePageForm = defineForm({
  fields: [
    {
      label: t("site.pages.field.name"),
      maxlength: MAX_NAME,
      name: "name",
      required: true,
      type: "text" as const,
    },
    {
      label: t("common.slug"),
      name: "slug",
      pattern: "[a-z0-9_-]+",
      required: true,
      title: t("fields.listing.slug_title"),
      type: "text" as const,
      validate: (value: string) => validateSlug(normalizeSlug(value)),
    },
    {
      hint: t("site.pages.field.meta_title_hint"),
      label: t("site.pages.field.meta_title"),
      maxlength: MAX_META_TITLE,
      name: "meta_title",
      type: "text" as const,
    },
    {
      hint: t("site.pages.field.meta_description_hint"),
      label: t("site.pages.field.meta_description"),
      maxlength: MAX_META_DESCRIPTION,
      name: "meta_description",
      type: "text" as const,
    },
    {
      hintHtml: FORMATTING_HINT,
      label: t("site.pages.field.content"),
      markdown: true,
      maxlength: MAX_TEXTAREA_LENGTH,
      name: "content",
      type: "textarea" as const,
    },
  ] as const,
  id: "sitePage",
});

/** Snake-case field values for pre-filling the edit form. */
export const pageToValues = (page: SitePage): Record<string, string> => ({
  content: page.content,
  meta_description: page.meta_description,
  meta_title: page.meta_title,
  name: page.name,
  slug: page.slug,
});
