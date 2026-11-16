/**
 * `news_posts` table operations — operator-written news posts.
 *
 * Cold-start efficiency is deliberate here, mirroring site-pages: the public
 * nav only needs to know whether ANY post exists (one indexed `LIMIT 1` read,
 * no decryption), the /news list and RSS feed read a **narrow projection**
 * (never the large `content`/`meta_*` blobs), and the full row is decrypted
 * one at a time, only for a single `/news/:slug` (or admin edit) view. Images
 * attach through the shared `image_uses` table with item_type 'news'.
 */

import { hmacHash } from "#crypto/hashing.ts";
import type { BlindIndex } from "#crypto/sealed.ts";
import {
  executeBatch,
  queryAll,
  resultRows,
  type TxScope,
  useTransaction,
} from "#db/client.ts";
import type { FillableRead } from "#db/fill-together.ts";
import {
  clearImageUsesForItemStatement,
  imageUseTargets,
  itemImageValues,
  openItemImages,
  type SealedItemImages,
} from "#db/images.ts";
import { readRows } from "#db/read.ts";
import { findRow, findRowWhere } from "#db/record-table.ts";
import { desc } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import type { Node } from "#db/select/shape.ts";
import { tables } from "#db/select/tables.ts";
import {
  freshSlugIndexWrites,
  unclaimedSlugCondition,
} from "#db/slug-registry.ts";
import {
  contentValues,
  type SluggedContentInput,
} from "#db/slugged-content-input.ts";
import { type SqlStatement, sql } from "#db/sql.ts";
import { deleteFrom } from "#db/write.ts";
import { fieldById, mapParallel } from "#fp";
import { registerTableInvalidation } from "#shared/cache-registry.ts";
import { nowIso } from "#shared/now.ts";
import { requestCache } from "#shared/request-cache.ts";
import type { Result } from "#shared/result.ts";
import { slugify, uniqueSlugFromBase } from "#shared/slug.ts";
import { isInstant } from "#shared/validation/timestamp.ts";
import type { NewsPost, NewsPostCard, NewsPostSummary } from "#types";

/** What the admin form provides: every editable column. The permalink is
 * derived on create, never entered, so `slug` and `created` are out. */
export type NewsPostWriteInput = Required<
  Omit<SluggedContentInput, "slug"> & { snippet: string }
>;

/** The posts newest first. */
const newestFirst = from(tables.news_posts)
  .as("news_post")
  .orderBy((post) => [desc(post.created), desc(post.id)]);

/** The summary columns of a post. */
const summaryColumns = (post: Node<"news_posts">) => ({
  created: post.created,
  id: post.id,
  name: post.name,
  slug: post.slug,
  snippet: post.snippet,
});

const unclaimedNewsSlugCondition = (
  slugIndex: BlindIndex,
  excludeId?: number,
) =>
  unclaimedSlugCondition(slugIndex, [
    {
      ...(excludeId === undefined ? {} : { excludeId }),
      table: "news_posts",
    },
  ]);

/** The permalink base for a post: its created date (yyyy-MM-dd) and name,
 * sluggified — e.g. `2026-07-06-big-launch`. Two same-day posts with the same
 * name get a `-2`, `-3`, … suffix from {@link uniqueSlugFromBase}. */
export const newsSlugBase = (created: string, name: string): string =>
  slugify(`${created.slice(0, 10)}-${name}`);

// The existence probe every public page's nav runs: one indexed LIMIT 1 read,
// nothing decrypted. Request-scoped and auto-cleared on any news_posts write.
const existenceStatement: SqlStatement = sql`SELECT id FROM news_posts LIMIT 1`;
const existenceCache = requestCache(() =>
  queryAll<{ id: number }>(existenceStatement),
);
registerTableInvalidation(["news_posts"], existenceCache.invalidate);

/** The existence probe as a read the nav can batch with its other small ones. */
export const newsExistenceRead: FillableRead = {
  fill: (result) => existenceCache.prime(resultRows<{ id: number }>(result)),
  statement: existenceStatement,
};

/** Does at least one news post exist? (Drives the public News nav link.) */
export const hasNewsPosts = async (): Promise<boolean> =>
  (await existenceCache.getAll()).length > 0;

/** Load the summary projection for every post, newest first: id, created,
 * slug, name, snippet — no image reads or decrypts. Feeds the RSS feed and the
 * admin list, which render no images. */
export const getNewsPostSummaries = (): Promise<NewsPostSummary[]> =>
  readRows(newestFirst.select(summaryColumns));

/** Open the sealed image values of one card. */
const openCard = async ({
  image_alt_text,
  image_thumb_url,
  image_url,
  ...summary
}: NewsPostSummary & SealedItemImages): Promise<NewsPostCard> => ({
  ...summary,
  ...(await openItemImages(
    { image_alt_text, image_thumb_url, image_url },
    `news post ${summary.id}`,
  )),
});

/** Load the card projection for every post, newest first: the summary plus
 * the post's first linked image — for the public /news list, the one reader
 * that shows pictures. */
export const getNewsPostCards = async (): Promise<NewsPostCard[]> => {
  const rows = await readRows(
    newestFirst.select((post) => ({
      ...summaryColumns(post),
      ...itemImageValues("news", post.id),
    })),
  );
  return mapParallel(openCard)(rows);
};

/** id → decrypted name for every post, newest first — the image library's
 * link-target labels (nothing but the name decrypted). */
export const getNewsPostNames = async (): Promise<Map<number, string>> => {
  const rows = await readRows(newestFirst.pick("id", "name"));
  return fieldById("name")(rows);
};

/** One full post (fully decrypted) by id — the admin single-post views.
 * Null when absent. */
export const getNewsPostById = (id: number): Promise<NewsPost | null> =>
  findRow(tables.news_posts, id);

/** One full post (fully decrypted) by blind-index slug lookup — the public
 * `/news/:slug` read. Null when absent. */
export const getNewsPostBySlugIndex = (
  slugIndex: BlindIndex,
): Promise<NewsPost | null> =>
  findRowWhere(tables.news_posts, { slug_index: slugIndex });

/** Create a post, stamping `created` now (the admin flow) or at a pinned time
 * (tests/restore), and deriving its immutable `/news` permalink from that date
 * and the name (unique within news_posts). */
export const createNewsPost = async (
  input: NewsPostWriteInput & { created?: string },
  transaction?: TxScope,
): Promise<NewsPost> => {
  const created = input.created ?? nowIso();
  // The permalink is built from this date and can never be rebuilt, so a caller
  // that pins a date it made up gets an error rather than a broken /news link.
  if (!isInstant(created)) {
    throw new Error(`News post created is not a real timestamp: "${created}"`);
  }
  return useTransaction(transaction, async (tx) => {
    const { slug } = await uniqueSlugFromBase({
      base: newsSlugBase(created, input.name),
      computeIndex: hmacHash,
      isTaken: async (slug) => {
        const condition = unclaimedNewsSlugCondition(await hmacHash(slug));
        return (
          resultRows(await tx.execute(sql`SELECT 1 WHERE NOT (${condition})`))
            .length > 0
        );
      },
    });
    const written = await newsPostWrites.create(
      async () => ({
        ...contentValues({ ...input, slug }),
        created,
        snippet: input.snippet,
      }),
      tx,
    );
    // The slug search above runs in the same transaction, so the slug is free.
    if (!written.ok) throw new Error(`News post slug "${slug}" is taken`);
    return written.value;
  });
};

/** Update a post's editable fields — every field, every time (the edit form
 * posts them all), including the (now editable) slug. `created` never changes.
 * The blind index is computed here and its uniqueness condition is part of the
 * UPDATE statement, so a concurrent rename returns `slugTaken`. */
const newsPostWrites = freshSlugIndexWrites(
  tables.news_posts,
  unclaimedNewsSlugCondition,
);

export const updateNewsPost = async (
  id: number,
  input: NewsPostWriteInput & { slug: string },
  transaction?: TxScope,
): Promise<Result<NewsPost, "notFound" | "slugTaken">> =>
  newsPostWrites.update(
    id,
    { ...contentValues(input), snippet: input.snippet },
    transaction,
  );

/** Delete a post and its image links in one batch (images themselves stay in
 * the library — only the uses are pruned, as with listing/group deletion). */
export const deleteNewsPostWithImages = (id: number): Promise<void> =>
  executeBatch([
    clearImageUsesForItemStatement(imageUseTargets.of("news")(id)),
    deleteFrom(tables.news_posts).where({ id }),
  ]);
