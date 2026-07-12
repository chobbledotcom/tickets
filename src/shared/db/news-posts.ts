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

// jscpd:ignore-start
import { mapParallel } from "#fp";
import { registerTableInvalidation } from "#shared/cache-registry.ts";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import type { BlindIndex, EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import {
  execute,
  executeBatch,
  queryAll,
  queryOne,
} from "#shared/db/client.ts";
// jscpd:ignore-end
import {
  defineIdTable,
  encryptedNameSchema,
  encryptedSeoContentSchema,
  encryptedSlugSchema,
  idAndCreatedSchema,
} from "#shared/db/common-schema.ts";
import {
  clearImageUsesForItemStatement,
  imageFilenameSubqueries,
} from "#shared/db/images.ts";
import type { SluggedContentInput } from "#shared/db/slugged-content-input.ts";
import { col } from "#shared/db/table.ts";
import { nowIso } from "#shared/now.ts";
import { requestCache } from "#shared/request-cache.ts";
import { slugify, uniqueSlugFromBase } from "#shared/slug.ts";
import type {
  ItemImageProjection,
  NewsPost,
  NewsPostCard,
  NewsPostSummary,
} from "#shared/types.ts";

/** Create/update input (camelCase keys → snake_case columns). `created`, `slug`,
 * and `slugIndex` are computed in {@link createNewsPost}, never posted by the
 * admin form (only restores and tests pin an explicit `created`). */
export type NewsPostInput = SluggedContentInput & {
  created?: string;
  snippet?: string;
};

/** Table with CRUD — all free text (including the slug) encrypted; `created`
 * and `slug_index` stay plaintext so ordering and slug lookups never
 * scan-and-decrypt. */
export const newsPostsTable = defineIdTable<NewsPost, NewsPostInput>(
  "news_posts",
  {
    ...encryptedNameSchema(encrypt, decrypt),
    ...encryptedSeoContentSchema(encrypt, decrypt),
    ...encryptedSlugSchema(encrypt, decrypt),
    ...idAndCreatedSchema(nowIso),
    snippet: col.encryptedText(encrypt, decrypt),
  },
);

/** What the admin form provides: every editable column. The permalink is
 * derived on create, never entered, so `slug`/`slugIndex`/`created` are out. */
export type NewsPostWriteInput = Required<
  Omit<NewsPostInput, "created" | "slug" | "slugIndex">
>;

/** The blind index for a news slug — lookup by `/news/:slug` without decrypting. */
export const computeNewsSlugIndex = (slug: string): Promise<BlindIndex> =>
  hmacHash(slug);

/** The permalink base for a post: its created date (yyyy-MM-dd) and name,
 * sluggified — e.g. `2026-07-06-big-launch`. Two same-day posts with the same
 * name get a `-2`, `-3`, … suffix from {@link uniqueSlugFromBase}. */
export const newsSlugBase = (created: string, name: string): string =>
  slugify(`${created.slice(0, 10)}-${name}`);

/** Is this exact slug already used by a news post (other than `excludeId`, when
 * given — an edit checks uniqueness against the OTHER posts)? News slugs live
 * under the `/news/` prefix, a namespace of their own, so uniqueness is scoped
 * to news_posts (not the shared listing/group/page slug registry). */
export const isNewsSlugTaken = async (
  slug: string,
  excludeId?: number,
): Promise<boolean> => {
  const slugIndex = await computeNewsSlugIndex(slug);
  const result =
    excludeId === undefined
      ? await execute("SELECT 1 FROM news_posts WHERE slug_index = ? LIMIT 1", [
          slugIndex,
        ])
      : await execute(
          "SELECT 1 FROM news_posts WHERE slug_index = ? AND id != ? LIMIT 1",
          [slugIndex, excludeId],
        );
  return result.rows.length > 0;
};

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
const decryptText = (value: EnvKeyEncrypted | ""): Promise<string> | string =>
  value === "" ? value : decrypt(value);

/** A summary row as stored: slug, name, and snippet still sealed. */
type SealedSummaryRow = Omit<NewsPostSummary, "slug" | "name" | "snippet"> & {
  slug: EnvKeyEncrypted;
  name: EnvKeyEncrypted;
  snippet: EnvKeyEncrypted | "";
};

/** A card row as stored: the sealed summary plus sealed image projections. */
type SealedCardRow = SealedSummaryRow & {
  [K in keyof ItemImageProjection]: EnvKeyEncrypted | "";
};

/** Decrypt one summary row (slug, name, and snippet). */
const decryptSummary = async (
  row: SealedSummaryRow,
): Promise<NewsPostSummary> => ({
  created: row.created,
  id: row.id,
  name: await decrypt(row.name),
  slug: await decrypt(row.slug),
  snippet: await decryptText(row.snippet),
});

/** Load the summary projection for every post, newest first: id, created,
 * slug, name, snippet — no image reads or decrypts. Feeds the RSS feed and the
 * admin list, which render no images. */
export const getNewsPostSummaries = async (): Promise<NewsPostSummary[]> => {
  const rows = await queryAll<SealedSummaryRow>(
    `SELECT id, created, slug, name, snippet
       FROM news_posts
      ORDER BY created DESC, id DESC`,
  );
  return mapParallel(decryptSummary)(rows);
};

/** Load the card projection for every post, newest first: the summary plus
 * the post's first linked image — for the public /news list, the one reader
 * that shows pictures. */
export const getNewsPostCards = async (): Promise<NewsPostCard[]> => {
  const rows = await queryAll<SealedCardRow>(
    `SELECT news_post.id, news_post.created, news_post.slug, news_post.name,
            news_post.snippet,
            ${imageFilenameSubqueries("news", "news_post.id")}
       FROM news_posts AS news_post
      ORDER BY news_post.created DESC, news_post.id DESC`,
  );
  return mapParallel(async (row: SealedCardRow) => ({
    ...(await decryptSummary(row)),
    image_alt_text: await decryptText(row.image_alt_text),
    image_thumb_url: await decryptText(row.image_thumb_url),
    image_url: await decryptText(row.image_url),
  }))(rows);
};

/** id → decrypted name for every post, newest first — the image library's
 * link-target labels (nothing but the name decrypted). */
export const getNewsPostNames = async (): Promise<Map<number, string>> => {
  const rows = await queryAll<{ id: number; name: EnvKeyEncrypted }>(
    "SELECT id, name FROM news_posts ORDER BY created DESC, id DESC",
  );
  const entries = await mapParallel(
    async (row: { id: number; name: EnvKeyEncrypted }) =>
      [row.id, await decrypt(row.name)] as const,
  )(rows);
  return new Map(entries);
};

/** One full post (fully decrypted) by id — the admin single-post views.
 * Null when absent. */
export const getNewsPostById = (id: number): Promise<NewsPost | null> =>
  newsPostsTable.findById(id);

/** Every {@link NewsPost} column, listed explicitly (AGENTS.md) so a future
 * column can't silently widen what the single-post read fetches and decrypts. */
const NEWS_POST_COLUMNS =
  "id, created, slug, slug_index, name, meta_title, meta_description, snippet, content";

/** One full post (fully decrypted) by blind-index slug lookup — the public
 * `/news/:slug` read. Null when absent. */
export const getNewsPostBySlugIndex = async (
  slugIndex: BlindIndex,
): Promise<NewsPost | null> => {
  const row = await queryOne<NewsPost>(
    `SELECT ${NEWS_POST_COLUMNS} FROM news_posts WHERE slug_index = ? LIMIT 1`,
    [slugIndex],
  );
  return row ? newsPostsTable.fromDb(row) : null;
};

/** Create a post, stamping `created` now (the admin flow) or at a pinned time
 * (tests/restore), and deriving its immutable `/news` permalink from that date
 * and the name (unique within news_posts). */
export const createNewsPost = async (
  input: NewsPostWriteInput & { created?: string },
): Promise<NewsPost> => {
  const created = input.created ?? nowIso();
  const { slug, slugIndex } = await uniqueSlugFromBase({
    base: newsSlugBase(created, input.name),
    computeIndex: computeNewsSlugIndex,
    isTaken: isNewsSlugTaken,
  });
  return newsPostsTable.insert({ ...input, created, slug, slugIndex });
};

/** Update a post's editable fields — every field, every time (the edit form
 * posts them all), including the (now editable) slug and its blind index.
 * `created` never changes. The caller normalises the slug and checks its
 * cross-post uniqueness (via {@link isNewsSlugTaken}) before calling. */
export const updateNewsPost = (
  id: number,
  input: NewsPostWriteInput & { slug: string; slugIndex: BlindIndex },
): Promise<NewsPost | null> => newsPostsTable.update(id, input);

/** Delete a post and its image links in one batch (images themselves stay in
 * the library — only the uses are pruned, as with listing/group deletion). */
export const deleteNewsPostWithImages = (id: number): Promise<void> =>
  executeBatch([
    clearImageUsesForItemStatement("news", id),
    { args: [id], sql: "DELETE FROM news_posts WHERE id = ?" },
  ]);
