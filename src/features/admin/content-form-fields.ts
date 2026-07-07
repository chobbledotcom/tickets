/**
 * The SEO/content form fields shared by the Site tab's content editors
 * (Pages, News): the required name, the optional meta title/description pair,
 * and the markdown body — plus the matching value helpers for pre-filling an
 * edit form and reading a submitted one.
 */

import { t } from "#i18n";
import type { FormParams } from "#shared/form-data.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { normalizeSlug, validateSlug } from "#shared/slug.ts";
import { formattingHint } from "#templates/fields.ts";

const MAX_NAME = 128;
const MAX_META_TITLE = 64;
const MAX_META_DESCRIPTION = 160;

/** The required display-name field (each editor supplies its own label). */
export const contentNameField = (label: string) =>
  ({
    label,
    maxlength: MAX_NAME,
    name: "name",
    required: true,
    type: "text",
  }) as const;

/** The editable slug field shared by the Site content editors (Pages, News):
 * slug-format validation plus, when a `publicLinkPath` is given, a "Public
 * link" to the saved slug's public page. The link is edit-only — omit the path
 * on a create form, where the entity has no live page yet and a restored slug
 * would otherwise render a link that 404s. */
export const contentSlugField = (publicLinkPath?: (slug: string) => string) =>
  ({
    hint: t("common.slug_public_hint"),
    label: t("common.slug"),
    name: "slug",
    pattern: "[a-z0-9_\\-]+",
    // Present only on edit forms — an absent path renders no public link.
    ...(publicLinkPath ? { publicLinkPath } : {}),
    required: true,
    title: t("fields.listing.slug_title"),
    type: "text",
    validate: (value: string) => validateSlug(normalizeSlug(value)),
  }) as const;

/** The optional SEO meta title + description pair. */
export const seoMetaFields = () =>
  [
    {
      hint: t("fields.meta_title_hint"),
      label: t("fields.meta_title"),
      maxlength: MAX_META_TITLE,
      name: "meta_title",
      type: "text",
    },
    {
      hint: t("fields.meta_description_hint"),
      label: t("fields.meta_description"),
      maxlength: MAX_META_DESCRIPTION,
      name: "meta_description",
      type: "text",
    },
  ] as const;

/** The markdown body field, with the formatting-help hint. */
export const markdownContentField = () =>
  ({
    hintHtml: formattingHint(),
    label: t("fields.content"),
    markdown: true,
    maxlength: MAX_TEXTAREA_LENGTH,
    name: "content",
    type: "textarea",
  }) as const;

/** Snake-case pre-fill values for the shared SEO/content fields. */
export const contentMetaValues = (row: {
  content: string;
  meta_description: string;
  meta_title: string;
  name: string;
}): Record<string, string> => ({
  content: row.content,
  meta_description: row.meta_description,
  meta_title: row.meta_title,
  name: row.name,
});

/** The submitted SEO/content columns shared by create and update. */
export const seoContentInput = (form: FormParams, name: string) => ({
  content: form.getString("content"),
  metaDescription: form.getString("meta_description"),
  metaTitle: form.getString("meta_title"),
  name,
});
