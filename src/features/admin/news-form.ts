/**
 * The shared news-post fields form (name, SEO meta, plain-text snippet,
 * markdown content), used by both the create and edit routes and rendered by
 * the admin templates.
 */

import { t } from "#i18n";
import { defineForm } from "#shared/forms.tsx";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import type { NewsPost } from "#shared/types.ts";
import { formattingHint } from "#templates/fields.ts";

const MAX_NAME = 128;
const MAX_META_TITLE = 64;
const MAX_META_DESCRIPTION = 160;
export const MAX_SNIPPET = 500;

export const newsPostForm = defineForm({
  fields: [
    {
      label: t("news.field.name"),
      maxlength: MAX_NAME,
      name: "name",
      required: true,
      type: "text" as const,
    },
    {
      hint: t("news.field.meta_title_hint"),
      label: t("news.field.meta_title"),
      maxlength: MAX_META_TITLE,
      name: "meta_title",
      type: "text" as const,
    },
    {
      hint: t("news.field.meta_description_hint"),
      label: t("news.field.meta_description"),
      maxlength: MAX_META_DESCRIPTION,
      name: "meta_description",
      type: "text" as const,
    },
    {
      hint: t("news.field.snippet_hint"),
      label: t("news.field.snippet"),
      maxlength: MAX_SNIPPET,
      name: "snippet",
      type: "textarea" as const,
    },
    {
      hintHtml: formattingHint(),
      label: t("news.field.content"),
      markdown: true,
      maxlength: MAX_TEXTAREA_LENGTH,
      name: "content",
      type: "textarea" as const,
    },
  ] as const,
  id: "newsPost",
});

/** Snake-case field values for pre-filling the edit form. */
export const newsPostToValues = (post: NewsPost): Record<string, string> => ({
  content: post.content,
  meta_description: post.meta_description,
  meta_title: post.meta_title,
  name: post.name,
  snippet: post.snippet,
});
