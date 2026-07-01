/**
 * `site_pages` table operations — user-created content pages (see pages.md).
 *
 * Cold-start efficiency is deliberate here: the public nav only needs a **narrow
 * projection** (id, slug, name, sort_order) and must not decrypt the large
 * `content` / `meta_*` blobs on every request. So the cached read
 * ({@link getSitePageNavRows}) selects and decrypts only those four columns; the
 * full row (with content/meta) is loaded one at a time, only for a single
 * `/page/:slug` (or admin edit) view.
 */

import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import {
  queryAll,
  queryOne,
  resultRows,
  withTransaction,
} from "#shared/db/client.ts";
import {
  defineIdTable,
  encryptedNameSchema,
  idAndEncryptedSlugSchema,
} from "#shared/db/common-schema.ts";
import { swapSortOrder } from "#shared/db/query.ts";
import { isSlugTakenAnywhere } from "#shared/db/slug-registry.ts";
import { cachedTable, col } from "#shared/db/table.ts";
import type { SitePage, SitePageNavRow } from "#shared/types.ts";

/** Create/update input (camelCase keys → snake_case columns). */
export type SitePageInput = {
  slug: string;
  slugIndex: string;
  name: string;
  metaTitle?: string;
  metaDescription?: string;
  content?: string;
  sortOrder: number;
};

/** Compute the blind-index HMAC for a page slug (lookup without decrypting). */
export const computeSitePageSlugIndex = (slug: string): Promise<string> =>
  hmacHash(slug);

/** Raw table with CRUD — all free text encrypted, `slug_index` is the HMAC. */
const rawSitePagesTable = defineIdTable<SitePage, SitePageInput>("site_pages", {
  ...encryptedNameSchema(encrypt, decrypt),
  ...idAndEncryptedSlugSchema(encrypt, decrypt),
  content: col.encryptedText(encrypt, decrypt),
  meta_description: col.encryptedText(encrypt, decrypt),
  meta_title: col.encryptedText(encrypt, decrypt),
  sort_order: col.simple<number>(),
});

/** Raw narrow projection row before decryption. */
type RawNavRow = { id: number; name: string; slug: string; sort_order: number };

/** Load the nav projection: only id/slug/name/sort_order, decrypting just slug
 * and name (never content/meta). Ordered by (sort_order, id). */
const fetchNavRows = async (): Promise<SitePageNavRow[]> => {
  const rows = await queryAll<RawNavRow>(
    "SELECT id, slug, name, sort_order FROM site_pages ORDER BY sort_order ASC, id ASC",
  );
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      name: await decrypt(r.name),
      slug: await decrypt(r.slug),
      sort_order: r.sort_order,
    })),
  );
};

// Request-scoped cache over the projection: computed once per request, fresh on
// the next request (no cross-isolate staleness), and auto-cleared on any write
// to site_pages (cachedTable registers the dependency on the table name).
const navCache = cachedTable({
  fetchAll: fetchNavRows,
  name: "site_pages_nav",
  table: rawSitePagesTable,
});

/** Table with CRUD (insert/update/delete/findById) — writes invalidate the cache. */
export const sitePagesTable = navCache.table;

/** Invalidate the nav projection cache (writes do this automatically). */
export const invalidateSitePagesCache = (): void => navCache.invalidate();

/** The narrow nav projection for every page, ordered (cached per request). */
export const getSitePageNavRows = (): Promise<SitePageNavRow[]> =>
  navCache.getAll();

/** Load one full page (all columns, fully decrypted) — for the public/admin
 * single-page views. Null when absent. */
const querySitePage = async (
  where: string,
  arg: number | string,
): Promise<SitePage | null> => {
  const row = await queryOne<SitePage>(
    `SELECT * FROM site_pages WHERE ${where} LIMIT 1`,
    [arg],
  );
  return row ? rawSitePagesTable.fromDb(row) : null;
};

/** One full page by blind-index slug lookup (the `/page/:slug` read). */
export const getSitePageBySlugIndex = (
  slugIndex: string,
): Promise<SitePage | null> => querySitePage("slug_index = ?", slugIndex);

/** One full page by id (the admin edit read). */
export const getSitePageById = (id: number): Promise<SitePage | null> =>
  querySitePage("id = ?", id);

/** Is `slug` already used by a listing, group, or another page? Delegates to the
 * shared cross-table registry. Reserved-word rejection is a separate check. */
export const isSitePageSlugTaken = (
  slug: string,
  excludeId?: number,
): Promise<boolean> =>
  isSlugTakenAnywhere(
    slug,
    excludeId ? { id: excludeId, table: "site_pages" } : undefined,
  );

/** A create provides every column (no DB-side defaults), so the created row can
 * be returned as constructed — without a post-commit read-back that could see
 * replica lag on remote libsql. */
type SitePageCreateInput = Omit<Required<SitePageInput>, "sortOrder">;

/** Create a page, appending it to the end of the root ordering. A new page is
 * always a root (no edges yet). The trailing `sort_order` (max + 1) is read and
 * the row inserted in **one write transaction**, so the whole create rolls back
 * as a unit — no orphan row on a mid-write failure — and two concurrent creates
 * serialise on the write lock to get distinct orders (equal orders would make a
 * reorder swap a no-op, leaving the pages unreorderable). The returned row is
 * built from the input + the assigned id/order, never read back. */
export const createSitePage = async (
  input: SitePageCreateInput,
): Promise<SitePage> => {
  const { id, sortOrder } = await withTransaction(async (tx) => {
    const res = await tx.execute({
      args: [],
      sql: "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM site_pages",
    });
    const nextOrder = Number(resultRows<{ next: number }>(res)[0]!.next);
    const stmt = await rawSitePagesTable.insertStatement!({
      ...input,
      sortOrder: nextOrder,
    });
    const result = await tx.execute(stmt);
    return { id: Number(result.lastInsertRowid), sortOrder: nextOrder };
  });
  return {
    content: input.content,
    id,
    meta_description: input.metaDescription,
    meta_title: input.metaTitle,
    name: input.name,
    slug: input.slug,
    slug_index: input.slugIndex,
    sort_order: sortOrder,
  };
};

/** Update a page's editable fields (all but id/sort_order). The caller passes a
 * freshly computed `slugIndex` alongside the slug so the blind index never drifts
 * from the encrypted slug (lookups + cross-table uniqueness key on slug_index). */
export const updateSitePage = (
  id: number,
  input: Partial<Omit<SitePageInput, "sortOrder">>,
): Promise<SitePage | null> => sitePagesTable.update(id, input);

/** Swap the `sort_order` of two root pages (the move-up/down apply step). */
export const swapSitePageOrder = (id1: number, id2: number): Promise<void> =>
  swapSortOrder("site_pages", id1, id2);
