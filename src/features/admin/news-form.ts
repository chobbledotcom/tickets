/**
 * The shared news-post fields form (name, SEO meta, plain-text snippet,
 * markdown content), used by both the create and edit routes and rendered by
 * the admin templates.
 */

import { t } from "#i18n";
import { defineForm } from "#shared/forms.tsx";
import type { NewsPost } from "#shared/types.ts";
import {
  contentMetaValues,
  contentNameField,
  contentSlugField,
  markdownContentField,
  seoMetaFields,
} from "./content-form-fields.ts";

export const MAX_SNIPPET = 500;

const nameField = contentNameField(t("news.field.name"));

/** The editable `/news/:slug` permalink — edit-only (a new post's slug is
 * auto-generated). Shows the saved slug's public link beneath the input. */
const slugField = contentSlugField((slug) => `/news/${slug}`);

/** The fields after the name, shared by the create and edit forms. */
const trailingFields = [
  ...seoMetaFields(),
  {
    hint: t("news.field.snippet_hint"),
    label: t("news.field.snippet"),
    maxlength: MAX_SNIPPET,
    name: "snippet",
    type: "textarea" as const,
  },
  markdownContentField(),
] as const;

/** The create form: no slug (the permalink is auto-generated on create). */
export const newsPostForm = defineForm({
  fields: [nameField, ...trailingFields] as const,
  id: "newsPost",
});

/** The edit form: the create fields plus the editable slug (right after name). */
export const newsPostEditForm = defineForm({
  fields: [nameField, slugField, ...trailingFields] as const,
  id: "newsPostEdit",
});

/** Snake-case field values for pre-filling the edit form (slug included). */
export const newsPostToValues = (post: NewsPost): Record<string, string> => ({
  ...contentMetaValues(post),
  slug: post.slug,
  snippet: post.snippet,
});
