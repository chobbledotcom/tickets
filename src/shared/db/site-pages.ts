/**
 * `site_pages` table operations — user-created content pages.
 *
 * Cold-start efficiency is deliberate here: the public nav only needs a **narrow
 * columns** (id, slug, name, sort_order, hidden) and must not decrypt the large
 * `content` / `meta_*` blobs on every request. So the cached read
 * ({@link sitePages}.getAll) selects and decrypts only those five columns; the
 * full row (with content/meta) is loaded one at a time, only for a single
 * `/page/:slug` (or admin edit) view.
 */

import type { BlindIndex } from "#crypto/sealed.ts";
import { resultRows, type TxScope } from "#db/client.ts";
import type { FillableRead } from "#db/fill-together.ts";
import { defineOrderedCollection } from "#db/ordered-collection.ts";
import { findRow, findRowWhere } from "#db/record-table.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import {
  freshSlugIndexWrites,
  type UnclaimedSlugCondition,
  unclaimedSiteSlugCondition,
} from "#db/slug-registry.ts";
import type { SluggedContentInput } from "#db/slugged-content-input.ts";
import type { SqlStatement } from "#db/sql.ts";
import { requestCachedRows } from "#db/table-cache.ts";
import { bindFirst } from "#shared/fp-bind.ts";
import type { Result } from "#shared/result.ts";
import type { SitePage } from "#types";

/** The nav columns of every page: id, slug, name, sort_order and hidden.
 * Only slug and name are decrypted. */
const navRowsRead = from(tables.site_pages)
  .sortedBy("sort_order", "id")
  .pick("hidden", "id", "name", "slug", "sort_order");

// Request-scoped cache over those columns: computed once per request, and
// cleared on any write to site_pages.
export const sitePages = requestCachedRows(
  tables.site_pages,
  () => navRowsRead,
);

/** The nav rows as a read the nav can batch with its other small ones. */
export const sitePagesNavRead: FillableRead = {
  fill: (result) => sitePages.prime(resultRows(result)),
  statement: navRowsRead,
};

export const sitePageOrder = defineOrderedCollection({
  key: "id",
  table: "site_pages",
});

/** Which of `ids` name a page that is really there — as a statement, so a
 * caller can ask inside its own write transaction and have the answer hold
 * for the writes it makes next. */
export const existingSitePageIdsStatement = (
  ids: readonly number[],
): SqlStatement => from(tables.site_pages).where({ id: ids }).pick("id");

/** One full page by blind-index slug lookup (the `/page/:slug` read). */
export const getSitePageBySlugIndex = (
  slugIndex: BlindIndex,
): Promise<SitePage | null> =>
  findRowWhere(tables.site_pages, { slug_index: slugIndex });

/** One full page by id (the admin edit read). */
export const getSitePageById = bindFirst(findRow)(tables.site_pages);

/** A create/update provides every editable column; the blind index is computed
 * HERE from the slug (never caller-supplied), so `slug` and `slug_index` move
 * together by construction — a drifted index would break lookups and the
 * cross-table uniqueness check, both of which key on `slug_index`. */
export type SitePageWriteInput = Required<SluggedContentInput> &
  Pick<SitePage, "hidden">;

/** Create a page, appending it to the end of the root ordering. A new page is
 * always a root (no edges yet). The trailing `sort_order` (max + 1) is read and
 * the row inserted in **one write transaction**, so the whole create rolls back
 * as a unit — no orphan row on a mid-write failure — and two concurrent creates
 * serialise on the write lock to get distinct orders (equal orders would make a
 * reorder swap a no-op, leaving the pages unreorderable). Slug availability is
 * part of the INSERT, so a concurrent owner returns `slugTaken`. */
/** The page's own unclaimed condition: every listing, group, and page slug
 * namespace, with this page's own row skipped on update. */
const unclaimedPageSlug: UnclaimedSlugCondition = (slugIndex, id) =>
  unclaimedSiteSlugCondition(
    slugIndex,
    id === undefined ? undefined : { id, table: "site_pages" },
  );

const sitePageWrites = freshSlugIndexWrites(
  tables.site_pages,
  unclaimedPageSlug,
  (input: SitePageWriteInput) => ({ hidden: input.hidden }),
);

export const createSitePage = (
  input: SitePageWriteInput,
  transaction?: TxScope,
): Promise<Result<SitePage, "slugTaken">> =>
  sitePageWrites.create(
    input,
    async (tx) => ({
      sort_order: await sitePageOrder.next({ transaction: tx }),
    }),
    transaction,
  );

/** Update a page's editable fields (all but id/sort_order) — every field, every
 * time (the edit form posts them all), with the blind index recomputed from the
 * slug here so a renamed slug stays findable/reservable. */
export const updateSitePage = sitePageWrites.update;

/** Swap the `sort_order` of two root pages (the move-up/down apply step). */
