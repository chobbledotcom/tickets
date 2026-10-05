/**
 * The SEO and content form fields shared by the Site tab's content editors
 * (Pages, News). The value helpers pre-fill an edit form and read a submitted
 * one.
 */

import { pick } from "@std/collections";
// jscpd:ignore-start
import { t } from "#i18n";
import { defineForm, type FormDefinition } from "#shared/forms/definition.ts";
import type { Field } from "#shared/forms/field.ts";
import { MAX_INPUT_LENGTH, MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { formattingHint } from "#templates/components/formatting-hint.ts";
import { slugFieldBase } from "#templates/fields/validators.ts";

// jscpd:ignore-end

/**
 * The shared SEO/content fields' character limits, keyed by the form field
 * name a new content editor imports.
 */
export const CONTENT_FIELD_LIMITS = {
  content: MAX_TEXTAREA_LENGTH,
  // The SEO caps are display limits, not storage limits. Search engines
  // truncate a title past ~64 characters and a description past ~160. A
  // longer value never shows however much the form accepts.
  meta_description: 160,
  meta_title: 64,
  name: MAX_INPUT_LENGTH,
} as const;

/** The required display-name field (each editor supplies its own label). */
const contentNameField = (label: string) =>
  ({
    label,
    maxlength: CONTENT_FIELD_LIMITS.name,
    name: "name",
    required: true,
    type: "text",
  }) as const;

/** The editable slug field shared by the Site content editors (Pages, News).
 * The field carries slug-format validation. With a `publicLinkPath` it also
 * carries a "Public link" to the saved slug's public page. The link is
 * edit-only: a create form omits the path, because the entity has no live page
 * yet. A restored slug on a create form must not render a link that 404s. */
export const contentSlugField = (publicLinkPath?: (slug: string) => string) =>
  ({
    ...slugFieldBase(),
    hint: t("common.slug_public_hint"),
    // Present only on edit forms — an absent path renders no public link.
    ...(publicLinkPath ? { publicLinkPath } : {}),
  }) as const;

const seoMetaFields = () =>
  [
    {
      hint: t("fields.meta_title_hint"),
      label: t("fields.meta_title"),
      maxlength: CONTENT_FIELD_LIMITS.meta_title,
      name: "meta_title",
      type: "text",
    },
    {
      hint: t("fields.meta_description_hint"),
      label: t("fields.meta_description"),
      maxlength: CONTENT_FIELD_LIMITS.meta_description,
      name: "meta_description",
      type: "text",
    },
  ] as const;

const markdownContentField = () =>
  ({
    hintHtml: formattingHint(),
    label: t("fields.content"),
    markdown: true,
    maxlength: CONTENT_FIELD_LIMITS.content,
    name: "content",
    type: "textarea",
  }) as const;

/** The fields after the name/slug, shared by the create and edit forms:
 * SEO meta, any per-editor extras (for example, the news snippet), then the
 * body. */
type TrailingContentFields<Extra extends readonly Field[]> = readonly [
  ...ReturnType<typeof seoMetaFields>,
  ...Extra,
  ReturnType<typeof markdownContentField>,
];

/** The create + edit form pair a Site content editor (Pages, News) uses. */
export type ContentForms<
  CreateSlug extends readonly Field[],
  Extra extends readonly Field[],
> = {
  createForm: FormDefinition<
    readonly [
      ReturnType<typeof contentNameField>,
      ...CreateSlug,
      ...TrailingContentFields<Extra>,
    ]
  >;
  editForm: FormDefinition<
    readonly [
      ReturnType<typeof contentNameField>,
      ReturnType<typeof contentSlugField>,
      ...TrailingContentFields<Extra>,
    ]
  >;
};

/**
 * Build the create + edit forms for a Site content editor (Pages, News).
 * The two editors share every field. A config carries what differs:
 *
 * - `createSlugFields` — `[contentSlugField()]` when the create form asks for
 *   the slug (Pages), `[]` when the slug is auto-generated on create (News).
 *   Either way the create form shows no public link: the entity has no live
 *   page yet. A restored-after-error slug must not render a link that 404s.
 * - `extraFields` — per-editor fields between the SEO meta pair and the
 *   markdown body (for example, the news snippet).
 * - `publicLinkPath` — the saved slug's public page, linked on the edit form.
 */
export const defineContentForms = <
  const CreateSlug extends readonly Field[],
  const Extra extends readonly Field[],
>(config: {
  createSlugFields: CreateSlug;
  extraFields: Extra;
  nameLabel: string;
  publicLinkPath: (slug: string) => string;
}): ContentForms<CreateSlug, Extra> => {
  const nameField = contentNameField(config.nameLabel);
  const trailingFields = [
    ...seoMetaFields(),
    ...config.extraFields,
    markdownContentField(),
  ] as const;
  return {
    createForm: defineForm({
      fields: [
        nameField,
        ...config.createSlugFields,
        ...trailingFields,
      ] as const,
    }),
    editForm: defineForm({
      fields: [
        nameField,
        contentSlugField(config.publicLinkPath),
        ...trailingFields,
      ] as const,
    }),
  };
};

/** Snake-case values for pre-filling a content editor's edit form. */
export const contentFieldValues = (row: {
  content: string;
  meta_description: string;
  meta_title: string;
  name: string;
  slug: string;
}): Record<string, string> =>
  pick(row, ["content", "meta_description", "meta_title", "name", "slug"]);

type SeoContentValues = {
  content: string;
  meta_description: string;
  meta_title: string;
  name: string;
};

type SeoContentInput = {
  content: string;
  metaDescription: string;
  metaTitle: string;
  name: string;
};

/** The validated SEO/content columns shared by create and update. */
export const seoContentInput = (values: SeoContentValues): SeoContentInput => ({
  content: values.content,
  metaDescription: values.meta_description,
  metaTitle: values.meta_title,
  name: values.name,
});
