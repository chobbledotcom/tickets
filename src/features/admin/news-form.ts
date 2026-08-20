/**
 * The news-post create and edit forms (name, SEO meta, plain-text snippet,
 * markdown content), built by the shared content-forms factory and rendered by
 * the admin templates. A new post's `/news/:slug` permalink is auto-generated,
 * so only the edit form carries the editable slug (with its public link).
 */

import { t } from "#i18n";
import type { NewsPost } from "#types";
import {
  contentFieldValues,
  defineContentForms,
} from "./content-form-fields.ts";

const MAX_SNIPPET = 500;

export const { createForm: newsPostForm, editForm: newsPostEditForm } =
  defineContentForms({
    createSlugFields: [],
    extraFields: [
      {
        hint: t("news.field.snippet_hint"),
        label: t("news.field.snippet"),
        maxlength: MAX_SNIPPET,
        name: "snippet",
        type: "textarea",
      },
    ] as const,
    nameLabel: t("news.field.name"),
    publicLinkPath: (slug) => `/news/${slug}`,
  });

/** Snake-case field values for pre-filling the edit form (slug included). */
export const newsPostToValues = (
  post: Pick<
    NewsPost,
    "content" | "meta_description" | "meta_title" | "name" | "slug" | "snippet"
  >,
): Record<string, string> => ({
  ...contentFieldValues(post),
  snippet: post.snippet,
});
