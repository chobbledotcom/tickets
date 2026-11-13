/**
 * The news-post record: its table, its one write rule, and its custom write
 * commands. News pages and the Site content editor both read this declaration.
 */

import {
  createNewsPost,
  deleteNewsPostWithImages,
  getNewsPostById,
  getNewsPostSummaries,
  type NewsPostWriteInput,
  updateNewsPost,
} from "#db/news-posts.ts";
import { t } from "#i18n";
import { defineNamedRowRecord } from "#shared/rest/named-record.ts";
import { logNameActivity, type RecordShapeOf } from "#shared/rest/record.ts";
import { contentCommands } from "#shared/rest/record-command.ts";
import { okResult } from "#shared/result.ts";
import type { NewsPost, NewsPostSummary } from "#types";

const logNews = logNameActivity("News post");

/** An update carries the slug the create generated. */
const newsUpdateInput = (
  input: NewsPostWriteInput & { slug?: string },
): NewsPostWriteInput & { slug: string } => {
  const slug = input.slug;
  if (slug === undefined) {
    throw new Error("A news post update must carry its slug");
  }
  return { ...input, slug };
};

export const newsRecord = defineNamedRowRecord<
  RecordShapeOf<
    NewsPost,
    NewsPostWriteInput & { slug?: string },
    NewsPost,
    never,
    NewsPostSummary
  >
>({
  activityName: "News post",
  getAll: getNewsPostSummaries,
  list: "news",
  load: getNewsPostById,
  write: contentCommands<
    NewsPost,
    NewsPostWriteInput & { slug?: string },
    "notFound" | "slugTaken"
  >({
    create: async (input, tx) => okResult(await createNewsPost(input, tx)),
    load: getNewsPostById,
    log: logNews,
    message: () => t("news.error.slug_taken"),
    notFound: "notFound",
    remove: (post) => deleteNewsPostWithImages(post.id),
    rule: (value) => okResult(value),
    update: (id, input, tx) => updateNewsPost(id, newsUpdateInput(input), tx),
    updateInput: newsUpdateInput,
  }),
});
