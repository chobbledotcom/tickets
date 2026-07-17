/**
 * `site_pages` table operations — user-created content pages.
 *
 * Cold-start efficiency is deliberate here: the public nav only needs a **narrow
 * projection** (id, slug, name, sort_order) and must not decrypt the large
 * `content` / `meta_*` blobs on every request. So the cached read
 * ({@link sitePages}.getAll) selects and decrypts only those four columns; the
 * full row (with content/meta) is loaded one at a time, only for a single
 * `/page/:slug` (or admin edit) view.
 */

/* jscpd:ignore-start */
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import type { BlindIndex } from "#shared/crypto/sealed.ts";
import {
  queryOne,
  resultRows,
  type TxScope,
  useTransaction,
} from "#shared/db/client.ts";
import {
  defineIdTable,
  idAndEncryptedSlugSchema,
} from "#shared/db/common-schema.ts";
import { encryptedNameAndSeoSchema } from "#shared/db/content-columns.ts";
import { swapSortOrder } from "#shared/db/query.ts";
import {
  unclaimedSiteSlugCondition,
  updateRowWithUnclaimedSlug,
} from "#shared/db/slug-registry.ts";
import type { SluggedContentInput } from "#shared/db/slugged-content-input.ts";
import {
  cachedTable,
  col,
  defineTableProjection,
  writeTableRow,
} from "#shared/db/table.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import type { SitePage, SitePageNavRow } from "#shared/types.ts";
/* jscpd:ignore-end */

/** Create/update input (camelCase keys → snake_case columns). */
export type SitePageInput = SluggedContentInput & {
  sortOrder: number;
};

/** Compute the blind-index HMAC for a page slug (lookup without decrypting). */
export const computeSitePageSlugIndex = (slug: string): Promise<BlindIndex> =>
  hmacHash(slug);

/** Raw table with CRUD — all free text encrypted, `slug_index` is the HMAC. */
const rawSitePagesTable = defineIdTable<SitePage, SitePageInput>("site_pages", {
  ...encryptedNameAndSeoSchema(encrypt, decrypt),
  ...idAndEncryptedSlugSchema(encrypt, decrypt),
  sort_order: col.simple<number>(),
});

const sitePageNavProjection = defineTableProjection(rawSitePagesTable, [
  "id",
  "slug",
  "name",
  "sort_order",
]);

/** Load the nav projection: only id/slug/name/sort_order, decrypting just slug
 * and name (never content/meta). Ordered by (sort_order, id). The raw row
 * carries name and slug still sealed; the map below opens them. */
const fetchNavRows = (): Promise<SitePageNavRow[]> =>
  sitePageNavProjection.queryAll(
    `SELECT ${sitePageNavProjection.columnsSql()} FROM site_pages ORDER BY sort_order ASC, id ASC`,
  );

// Request-scoped cache over the projection: computed once per request, fresh on
// the next request (no cross-isolate staleness), and auto-cleared on any write
// to site_pages (cachedTable registers the dependency on the table name).
export const sitePages = cachedTable({
  fetchAll: fetchNavRows,
  name: "site_pages_nav",
  table: rawSitePagesTable,
});

/** Every {@link SitePage} column, listed explicitly (AGENTS.md) so a future
 * column can't silently widen what the single-page reads fetch and decrypt. */
const SITE_PAGE_COLUMNS =
  "id, slug, slug_index, name, meta_title, meta_description, content, sort_order";

/** Load one full page (fully decrypted) — for the public/admin single-page
 * views. Null when absent. */
const querySitePage = async (
  where: string,
  arg: number | string,
): Promise<SitePage | null> => {
  const row = await queryOne<SitePage>(
    `SELECT ${SITE_PAGE_COLUMNS} FROM site_pages WHERE ${where} LIMIT 1`,
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

/** A create/update provides every editable column; the blind index is computed
 * HERE from the slug (never caller-supplied), so `slug` and `slug_index` move
 * together by construction — a drifted index would break lookups and the
 * cross-table uniqueness check, both of which key on `slug_index`. */
export type SitePageWriteInput = Omit<
  Required<SitePageInput>,
  "sortOrder" | "slugIndex"
>;

/** Create a page, appending it to the end of the root ordering. A new page is
 * always a root (no edges yet). The trailing `sort_order` (max + 1) is read and
 * the row inserted in **one write transaction**, so the whole create rolls back
 * as a unit — no orphan row on a mid-write failure — and two concurrent creates
 * serialise on the write lock to get distinct orders (equal orders would make a
 * reorder swap a no-op, leaving the pages unreorderable). Slug availability is
 * part of the INSERT, so a concurrent owner returns `slugTaken`. */
export const createSitePage = async (
  input: SitePageWriteInput,
  transaction?: TxScope,
): Promise<Result<SitePage, "slugTaken">> => {
  const slugIndex = await computeSitePageSlugIndex(input.slug);
  return useTransaction(transaction, async (tx) => {
    const res = await tx.execute({
      args: [],
      sql: "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM site_pages",
    });
    const nextOrder = Number(resultRows<{ next: number }>(res)[0]!.next);
    const row = await writeTableRow(tx, rawSitePagesTable, {
      condition: unclaimedSiteSlugCondition(slugIndex),
      input: {
        ...input,
        slugIndex,
        sortOrder: nextOrder,
      },
      kind: "insert",
    });
    return row ? okResult(row) : errorResult("slugTaken");
  });
};

/** Update a page's editable fields (all but id/sort_order) — every field, every
 * time (the edit form posts them all), with the blind index recomputed from the
 * slug here so a renamed slug stays findable/reservable. */
export const updateSitePage = async (
  id: number,
  input: SitePageWriteInput,
  transaction?: TxScope,
): Promise<Result<SitePage, "notFound" | "slugTaken">> => {
  const slugIndex = await computeSitePageSlugIndex(input.slug);
  return updateRowWithUnclaimedSlug(
    sitePages.table,
    id,
    { ...input, slugIndex },
    unclaimedSiteSlugCondition(slugIndex, { id, table: "site_pages" }),
    transaction,
  );
};

/** Swap the `sort_order` of two root pages (the move-up/down apply step). */
export const swapSitePageOrder = (id1: number, id2: number): Promise<void> =>
  swapSortOrder("site_pages", id1, id2);
