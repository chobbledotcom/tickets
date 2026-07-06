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
  markdownContentField,
  seoMetaFields,
} from "./content-form-fields.ts";

export const MAX_SNIPPET = 500;

export const newsPostForm = defineForm({
  fields: [
    contentNameField(t("news.field.name")),
    ...seoMetaFields(),
    {
      hint: t("news.field.snippet_hint"),
      label: t("news.field.snippet"),
      maxlength: MAX_SNIPPET,
      name: "snippet",
      type: "textarea" as const,
    },
    markdownContentField(),
  ] as const,
  id: "newsPost",
});

/** Snake-case field values for pre-filling the edit form. */
export const newsPostToValues = (post: NewsPost): Record<string, string> => ({
  ...contentMetaValues(post),
  snippet: post.snippet,
});
