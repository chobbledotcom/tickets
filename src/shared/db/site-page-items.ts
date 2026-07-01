/**
 * `site_page_items` edge operations — the ordered membership of listings,
 * groups, and sub-pages inside a page (see pages.md). Edges carry no encrypted
 * data, so reads are cheap; the whole set feeds the public nav's forest.
 *
 * The single-parent invariant for pages (N3) has no DB constraint (the schema
 * can't express a partial-unique index), so {@link addPageItem} serialises the
 * existence check, next-order computation, and insert in **one write
 * transaction** — two concurrent adds of the same page can't both slip through.
 */

import type { InValue } from "@libsql/client";
import { registerTableInvalidation } from "#shared/cache-registry.ts";
import {
  executeBatch,
  queryAll,
  resultRows,
  withTransaction,
} from "#shared/db/client.ts";
import { requestCache } from "#shared/request-cache.ts";
import { buildForest, wouldCreateCycle } from "#shared/site-pages/core.ts";
import type { SitePageItem, SitePageItemType } from "#shared/types.ts";

/** A parameterised statement for a batch / transaction. */
type Stmt = { sql: string; args: InValue[] };

const SELECT_COLS = "page_id, item_type, item_id, sort_order";

const fetchAllItems = (): Promise<SitePageItem[]> =>
  queryAll<SitePageItem>(
    `SELECT ${SELECT_COLS} FROM site_page_items ORDER BY page_id ASC, sort_order ASC, item_id ASC`,
  );

// Request-scoped: one query per request feeds the whole nav forest, fresh next
// request, and cleared on any write to site_page_items.
const itemsCache = requestCache(fetchAllItems);
registerTableInvalidation(["site_page_items"], () => itemsCache.invalidate());

/** Every edge, ordered — the single read the public nav's forest is built from. */
export const getAllPageItems = (): Promise<SitePageItem[]> =>
  itemsCache.getAll();

/** Invalidate the edge cache (writes do this automatically). */
export const invalidatePageItemsCache = (): void => itemsCache.invalidate();

/** The items of one page, ordered (includes `page_id` so rows are full
 * {@link SitePageItem}s the core can consume). */
export const getItemsForPage = (pageId: number): Promise<SitePageItem[]> =>
  queryAll<SitePageItem>(
    `SELECT ${SELECT_COLS} FROM site_page_items WHERE page_id = ? ORDER BY sort_order ASC, item_id ASC`,
    [pageId],
  );

/**
 * Add an item to a page, or report a conflict. The existence + tree checks and
 * the insert all run in **one write transaction**, so concurrent adds serialise
 * on the write lock and can never create a duplicate edge or a second parent —
 * the loser simply sees the row already there. Returns `false` (nothing
 * inserted) when the edge already exists, the page is already nested elsewhere
 * (single-parent, N3), or nesting would close a cycle (N4); `true` when the edge
 * was created. The new row gets `sort_order = MAX(page's orders) + 1` (0 first).
 */
export const addPageItem = (
  pageId: number,
  itemType: SitePageItemType,
  itemId: number,
): Promise<boolean> =>
  withTransaction(async (tx) => {
    // Duplicate edge (the unique (page_id, item_type, item_id) key): checked
    // in-transaction so a concurrent repeat can't slip past to the raw index.
    const duplicate = resultRows<SitePageItem>(
      await tx.execute({
        args: [pageId, itemType, itemId],
        sql: `SELECT ${SELECT_COLS} FROM site_page_items WHERE page_id = ? AND item_type = ? AND item_id = ?`,
      }),
    );
    if (duplicate.length > 0) return false;
    if (itemType === "page") {
      // Read all page edges once and enforce both page invariants against the
      // same in-transaction snapshot, before inserting.
      const pageEdges = resultRows<SitePageItem>(
        await tx.execute({
          args: [],
          sql: `SELECT ${SELECT_COLS} FROM site_page_items WHERE item_type = 'page'`,
        }),
      );
      // Single-parent (N3): the page must not already be nested elsewhere.
      if (pageEdges.some((e) => e.item_id === itemId)) return false;
      // Acyclic (N4): nesting it here must not close a loop (self or ancestor).
      if (wouldCreateCycle(buildForest([], pageEdges), pageId, itemId)) {
        return false;
      }
    }
    const orderRes = await tx.execute({
      args: [pageId],
      sql: "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM site_page_items WHERE page_id = ?",
    });
    // The aggregate always returns exactly one row, so read it directly rather
    // than guarding an impossible empty result.
    const next = Number(resultRows<{ next: number }>(orderRes)[0]!.next);
    await tx.execute({
      args: [pageId, itemType, itemId, next],
      sql: "INSERT INTO site_page_items (page_id, item_type, item_id, sort_order) VALUES (?, ?, ?, ?)",
    });
    return true;
  });

/** Remove one item from a page (by its composite key). */
export const removePageItem = (
  pageId: number,
  itemType: SitePageItemType,
  itemId: number,
): Promise<void> =>
  executeBatch([itemDeleteStatement(pageId, itemType, itemId)]);

const itemDeleteStatement = (
  pageId: number,
  itemType: SitePageItemType,
  itemId: number,
): Stmt => ({
  args: [pageId, itemType, itemId],
  sql: "DELETE FROM site_page_items WHERE page_id = ? AND item_type = ? AND item_id = ?",
});

/** Identifies one item within a page by its composite key. */
export type ItemRef = { type: SitePageItemType; id: number };

/**
 * Swap the `sort_order` of two items within a page, matched on the full
 * composite key (`item_id` alone isn't unique within a page — a listing, group,
 * and page can share a numeric id). No-op if either row is missing.
 */
export const swapPageItemOrder = (
  pageId: number,
  a: ItemRef,
  b: ItemRef,
): Promise<void> =>
  // Read the two orders and write the swap in one transaction, so concurrent
  // reorders serialise instead of applying stale snapshots and duplicating
  // orders (there is no (page_id, sort_order) constraint to repair drift).
  withTransaction(async (tx) => {
    const rows = resultRows<{
      item_id: number;
      item_type: SitePageItemType;
      sort_order: number;
    }>(
      await tx.execute({
        args: [pageId, a.type, a.id, b.type, b.id],
        sql: `SELECT item_type, item_id, sort_order FROM site_page_items
      WHERE page_id = ? AND ((item_type = ? AND item_id = ?) OR (item_type = ? AND item_id = ?))`,
      }),
    );
    const orderOf = (ref: ItemRef): number | undefined =>
      rows.find((r) => r.item_type === ref.type && r.item_id === ref.id)
        ?.sort_order;
    const oa = orderOf(a);
    const ob = orderOf(b);
    if (oa === undefined || ob === undefined) return;
    await tx.execute(setOrderStatement(pageId, a, ob));
    await tx.execute(setOrderStatement(pageId, b, oa));
  });

const setOrderStatement = (
  pageId: number,
  ref: ItemRef,
  order: number,
): Stmt => ({
  args: [order, pageId, ref.type, ref.id],
  sql: "UPDATE site_page_items SET sort_order = ? WHERE page_id = ? AND item_type = ? AND item_id = ?",
});

/**
 * Delete a page and every edge touching it — its own items and any edge naming
 * it as a child `page` — in one batch (single implicit transaction), so a
 * partial failure can never leave a dangling edge. Former children become roots.
 */
export const deleteSitePageWithEdges = (pageId: number): Promise<void> =>
  executeBatch([
    { args: [pageId], sql: "DELETE FROM site_page_items WHERE page_id = ?" },
    {
      args: [pageId],
      sql: "DELETE FROM site_page_items WHERE item_type = 'page' AND item_id = ?",
    },
    { args: [pageId], sql: "DELETE FROM site_pages WHERE id = ?" },
  ]);

/**
 * The statement that clears every edge pointing at a listing/group, for callers
 * to fold into that entity's own delete batch (so the cleanup is atomic with the
 * row delete — no dangling public-nav entry).
 */
export const clearItemEdgesStatement = (
  itemType: "listing" | "group",
  itemId: number,
): Stmt => ({
  args: [itemType, itemId],
  sql: "DELETE FROM site_page_items WHERE item_type = ? AND item_id = ?",
});
