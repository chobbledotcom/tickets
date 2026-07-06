/**
 * `news_posts` table operations — operator-written news posts.
 *
 * Cold-start efficiency is deliberate here, mirroring site-pages: the public
 * nav only needs to know whether ANY post exists (one indexed `LIMIT 1` read,
 * no decryption), the /news list and RSS feed read a **narrow projection**
 * (never the large `content`/`meta_*` blobs), and the full row is decrypted
 * one at a time, only for a single `/news/:id` (or admin edit) view. Images
 * attach through the shared `image_uses` table with item_type 'news'.
 */

import { mapParallel } from "#fp";
import { registerTableInvalidation } from "#shared/cache-registry.ts";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { executeBatch, queryAll } from "#shared/db/client.ts";
import {
  defineIdTable,
  encryptedNameSchema,
  encryptedSeoContentSchema,
  idAndCreatedSchema,
} from "#shared/db/common-schema.ts";
import {
  clearImageUsesForItemStatement,
  imageFilenameSubqueries,
} from "#shared/db/images.ts";
import { col } from "#shared/db/table.ts";
import { nowIso } from "#shared/now.ts";
import { requestCache } from "#shared/request-cache.ts";
import type { NewsPost, NewsPostCard } from "#shared/types.ts";

/** Create/update input (camelCase keys → snake_case columns). `created`
 * defaults to now at insert time; the admin flow never supplies it (only
 * restores and tests pin an explicit stamp). */
export type NewsPostInput = {
  created?: string;
  name: string;
  metaTitle?: string;
  metaDescription?: string;
  snippet?: string;
  content?: string;
};

/** Table with CRUD — all free text encrypted; `created` stays plaintext (like
 * listings.created) so the newest-first ordering never scans-and-decrypts. */
export const newsPostsTable = defineIdTable<NewsPost, NewsPostInput>(
  "news_posts",
  {
    ...encryptedNameSchema(encrypt, decrypt),
    ...encryptedSeoContentSchema(encrypt, decrypt),
    ...idAndCreatedSchema(nowIso),
    snippet: col.encryptedText(encrypt, decrypt),
  },
);

/** A create/update provides every editable column (the forms post them all);
 * `created` is stamped by the column default and never editable. */
export type NewsPostWriteInput = Required<Omit<NewsPostInput, "created">>;

// The existence probe every public page's nav runs: one indexed LIMIT 1 read,
// nothing decrypted. Request-scoped and auto-cleared on any news_posts write.
const existenceCache = requestCache(() =>
  queryAll<{ id: number }>("SELECT id FROM news_posts LIMIT 1"),
);
registerTableInvalidation(["news_posts"], () => existenceCache.invalidate());

/** Does at least one news post exist? (Drives the public News nav link.) */
export const hasNewsPosts = async (): Promise<boolean> =>
  (await existenceCache.getAll()).length > 0;

/** Decrypt an encrypted-text value, honouring the `''` = "no value" convention
 * (matches `col.encryptedText`'s read — an empty column never decrypts). */
const decryptText = (value: string): Promise<string> | string =>
  value === "" ? value : decrypt(value);

/** Load the card projection for every post, newest first: id, created, name,
 * snippet, and the post's first linked image — decrypting just name, snippet,
 * and the image fields (never content/meta). Feeds /news and the RSS feed. */
export const getNewsPostCards = async (): Promise<NewsPostCard[]> => {
  const rows = await queryAll<NewsPostCard>(
    `SELECT news_post.id, news_post.created, news_post.name, news_post.snippet,
            ${imageFilenameSubqueries("news", "news_post.id")}
       FROM news_posts AS news_post
      ORDER BY news_post.created DESC, news_post.id DESC`,
  );
  return mapParallel(async (row: NewsPostCard) => ({
    created: row.created,
    id: row.id,
    image_alt_text: await decryptText(row.image_alt_text),
    image_thumb_url: await decryptText(row.image_thumb_url),
    image_url: await decryptText(row.image_url),
    name: await decrypt(row.name),
    snippet: await decryptText(row.snippet),
  }))(rows);
};

/** id → decrypted name for every post, newest first — the image library's
 * link-target labels (nothing but the name decrypted). */
export const getNewsPostNames = async (): Promise<Map<number, string>> => {
  const rows = await queryAll<{ id: number; name: string }>(
    "SELECT id, name FROM news_posts ORDER BY created DESC, id DESC",
  );
  const entries = await mapParallel(
    async (row: { id: number; name: string }) =>
      [row.id, await decrypt(row.name)] as const,
  )(rows);
  return new Map(entries);
};

/** One full post (fully decrypted) by id — the public/admin single-post views.
 * Null when absent. */
export const getNewsPostById = (id: number): Promise<NewsPost | null> =>
  newsPostsTable.findById(id);

/** Create a post; `created` is stamped now by the column default. */
export const createNewsPost = (input: NewsPostWriteInput): Promise<NewsPost> =>
  newsPostsTable.insert(input);

/** Update a post's editable fields — every field, every time (the edit form
 * posts them all). `created` never changes. */
export const updateNewsPost = (
  id: number,
  input: NewsPostWriteInput,
): Promise<NewsPost | null> => newsPostsTable.update(id, input);

/** Delete a post and its image links in one batch (images themselves stay in
 * the library — only the uses are pruned, as with listing/group deletion). */
export const deleteNewsPostWithImages = (id: number): Promise<void> =>
  executeBatch([
    clearImageUsesForItemStatement("news", id),
    { args: [id], sql: "DELETE FROM news_posts WHERE id = ?" },
  ]);
