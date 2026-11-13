/**
 * The news-post record: its table, its one write rule, and its custom write
 * commands. News pages and the Site content editor both read this declaration.
 */

import { withTransaction } from "#db/client.ts";
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
import { logNameActivity } from "#shared/rest/record.ts";
import {
  deleteCommand,
  transactCommand,
  updateIfPresent,
} from "#shared/rest/record-command.ts";
import { okResult } from "#shared/result.ts";
import type { NewsPost, NewsPostSummary } from "#types";

const logNews = logNameActivity("News post");

export const newsRecord = defineNamedRowRecord<
  NewsPost,
  NewsPostWriteInput & { slug?: string },
  NewsPost,
  never,
  NewsPostSummary
>({
  activityName: "News post",
  getAll: getNewsPostSummaries,
  list: "news",
  load: getNewsPostById,
  /* jscpd:ignore-start -- declarative command config, one per content record */
  write: {
    create: (input) =>
      withTransaction(async (tx) => {
        const post = await createNewsPost(input, tx);
        await logNews(post.name, "created", tx);
        return { kind: "written", row: post };
      }),
    remove: deleteCommand(
      getNewsPostById,
      (post) => deleteNewsPostWithImages(post.id),
      (post) => logNews(post.name, "deleted"),
    ),
    update: (id, input) =>
      updateIfPresent(
        getNewsPostById,
        () => {
          const slug = input.slug;
          if (slug === undefined) {
            throw new Error("A news post update must carry its slug");
          }
          return transactCommand<
            NewsPost,
            NewsPostWriteInput & { slug: string },
            "notFound" | "slugTaken"
          >({
            input: { ...input, slug },
            log: (post, tx) => logNews(post.name, "updated", tx),
            message: () => t("news.error.slug_taken"),
            notFound: "notFound",
            rule: (value) => okResult(value),
            write: (tx, value) => updateNewsPost(id, value, tx),
          });
        },
        id,
        input,
      ),
  },
  /* jscpd:ignore-end */
});
