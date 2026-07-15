/**
 * The SEO/content form fields shared by the Site tab's content editors
 * (Pages, News): the required name, the optional meta title/description pair,
 * and the markdown body — plus the matching value helpers for pre-filling an
 * edit form and reading a submitted one.
 */

// jscpd:ignore-start
import { t } from "#i18n";
import { defineForm, type FormDefinition } from "#shared/forms/definition.ts";
import type { Field } from "#shared/forms.tsx";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { formattingHint } from "#templates/components/formatting-hint.ts";
import { slugFieldBase } from "#templates/fields/validators.ts";

// jscpd:ignore-end

const MAX_NAME = 128;
const MAX_META_TITLE = 64;
const MAX_META_DESCRIPTION = 160;

/** The required display-name field (each editor supplies its own label). */
const contentNameField = (label: string) =>
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
    ...slugFieldBase(),
    hint: t("common.slug_public_hint"),
    // Present only on edit forms — an absent path renders no public link.
    ...(publicLinkPath ? { publicLinkPath } : {}),
  }) as const;

/** The optional SEO meta title + description pair. */
const seoMetaFields = () =>
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
const markdownContentField = () =>
  ({
    hintHtml: formattingHint(),
    label: t("fields.content"),
    markdown: true,
    maxlength: MAX_TEXTAREA_LENGTH,
    name: "content",
    type: "textarea",
  }) as const;

/** The fields after the name/slug, shared by the create and edit forms:
 * SEO meta, any per-editor extras (e.g. the news snippet), then the body. */
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
 * The two editors share every field; a config carries what differs:
 *
 * - `createSlugFields` — `[contentSlugField()]` when the create form asks for
 *   the slug (Pages), `[]` when the slug is auto-generated on create (News).
 *   Either way the create form shows no public link: the entity has no live
 *   page yet, and a restored-after-error slug must not render a link that 404s.
 * - `extraFields` — per-editor fields between the SEO meta pair and the
 *   markdown body (e.g. the news snippet).
 * - `publicLinkPath` — the saved slug's public page, linked on the edit form.
 */
export const defineContentForms = <
  const CreateSlug extends readonly Field[],
  const Extra extends readonly Field[],
>(config: {
  createSlugFields: CreateSlug;
  extraFields: Extra;
  /** Form ids: `<id>` for create, `<id>Edit` for edit. */
  id: string;
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
      id: config.id,
    }),
    editForm: defineForm({
      fields: [
        nameField,
        contentSlugField(config.publicLinkPath),
        ...trailingFields,
      ] as const,
      id: `${config.id}Edit`,
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
}): Record<string, string> => ({
  content: row.content,
  meta_description: row.meta_description,
  meta_title: row.meta_title,
  name: row.name,
  slug: row.slug,
});

type SeoContentValues = {
  content: string | null;
  meta_description: string | null;
  meta_title: string | null;
  name: string;
};

type SeoContentInput = {
  content: string;
  metaDescription: string;
  metaTitle: string;
  name: string;
};

export const textOrEmpty = (value: string | null): string =>
  value === null ? "" : value;

/** The validated SEO/content columns shared by create and update. */
export const seoContentInput = (values: SeoContentValues): SeoContentInput => ({
  content: textOrEmpty(values.content),
  metaDescription: textOrEmpty(values.meta_description),
  metaTitle: textOrEmpty(values.meta_title),
  name: values.name,
});
