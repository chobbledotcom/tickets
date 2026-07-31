/**
 * `site_page_items` edge operations — the ordered membership of listings,
 * groups, and sub-pages inside a page. Edges carry no encrypted
 * data, so reads are cheap; the whole set feeds the public nav's forest.
 *
 * The single-parent invariant for pages has no DB constraint (the schema
 * can't express a partial-unique index), so {@link addPageItem} serialises the
 * existence check, next-order computation, and insert in **one write
 * transaction** — two concurrent adds of the same page can't both slip through.
 */

import { registerTableInvalidation } from "#shared/cache-registry.ts";
import {
  execute,
  executeBatch,
  queryAll,
  resultRows,
  type SqlStatement,
  type TxScope,
  useTransaction,
} from "#shared/db/client.ts";
import {
  clearImageUsesForItemStatement,
  imageUseTargets,
} from "#shared/db/images.ts";
import { defineOrderedCollection } from "#shared/db/ordered-collection.ts";
import { existingSitePageIdsStatement } from "#shared/db/site-pages.ts";
import {
  clauseArgs,
  deleteWhere,
  equals,
  type WhereClause,
  whereSql,
} from "#shared/db/where-clauses.ts";
import { requestCache } from "#shared/request-cache.ts";
import {
  pageParentMapFromEdges,
  wouldCreateCycle,
} from "#shared/site-pages/core.ts";
import {
  type SitePageItemTarget,
  sitePageItemTargets,
} from "#shared/site-pages/target.ts";
import type { SitePageItem, SitePageItemType } from "#shared/types.ts";

const SELECT_COLS = "page_id, item_type, item_id, sort_order";

/** One item on one page — the composite key the edge table is unique on. */
const itemOnPage = (
  pageId: number,
  target: SitePageItemTarget,
): WhereClause[] => [
  ...equals("page_id", pageId),
  ...sitePageItemTargets.where(target),
];

/**
 * The statement that clears every edge pointing at one listing, group, or page,
 * for callers to fold into that record's own delete batch (so the cleanup is
 * atomic with the row delete — no dangling public-nav entry).
 */
export const clearItemEdgesStatement =
  sitePageItemTargets.deleteFrom("site_page_items");

export const sitePageItemOrder = defineOrderedCollection({
  key: ["item_type", "item_id"] as const,
  scope: "page_id",
  table: "site_page_items",
});

const fetchAllItems = (): Promise<SitePageItem[]> =>
  queryAll<SitePageItem>(
    `SELECT ${SELECT_COLS} FROM site_page_items ORDER BY page_id ASC, sort_order ASC, item_id ASC`,
  );

// Request-scoped: one query per request feeds the whole nav forest, fresh next
// request, and cleared on any write to site_page_items.
const itemsCache = requestCache(fetchAllItems);
registerTableInvalidation(["site_page_items"], itemsCache.invalidate);

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

type PageItemChange<T> = (
  pageId: number,
  itemType: SitePageItemType,
  itemId: number,
  transaction?: TxScope,
) => Promise<T>;

type PageItemChangeInTransaction<T> = (
  transaction: TxScope,
  pageId: number,
  itemType: SitePageItemType,
  itemId: number,
) => Promise<T>;

/** Give a page-item change the caller's transaction, or open its own. A simple
 * change may provide a one-statement direct path to avoid opening an interactive
 * transaction when called by itself. */
const pageItemChange =
  <T>(
    change: PageItemChangeInTransaction<T>,
    direct?: (
      pageId: number,
      itemType: SitePageItemType,
      itemId: number,
    ) => Promise<T>,
  ): PageItemChange<T> =>
  (pageId, itemType, itemId, transaction) =>
    transaction === undefined && direct
      ? direct(pageId, itemType, itemId)
      : useTransaction(transaction, (tx) =>
          change(tx, pageId, itemType, itemId),
        );

/**
 * Add an item to a page, or report a conflict. The existence + tree checks and
 * the insert all run in **one write transaction**, so concurrent adds serialise
 * on the write lock and can never create a duplicate edge or a second parent —
 * the loser simply sees the row already there. Returns `false` (nothing
 * inserted) when the edge already exists, the page is already nested elsewhere
 * (single-parent), or nesting would close a cycle; `true` when the edge
 * was created. The new row gets `sort_order = MAX(page's orders) + 1` (0 first).
 */
const addPageItemInTransaction: PageItemChangeInTransaction<boolean> = async (
  tx,
  pageId: number,
  itemType: SitePageItemType,
  itemId: number,
): Promise<boolean> => {
  // Existence, read in the SAME transaction and bounded to the ids at hand:
  // the host page (and, for a page item, the child page) must still exist,
  // so a stale add racing a delete can never insert a dangling page edge.
  const requiredIds = [
    ...new Set([pageId, ...(itemType === "page" ? [itemId] : [])]),
  ];
  const pageRows = resultRows<{ id: number }>(
    await tx.execute(existingSitePageIdsStatement(requiredIds)),
  );
  if (pageRows.length !== requiredIds.length) return false;
  // Duplicate edge (the unique (page_id, item_type, item_id) key): checked
  // in-transaction so a concurrent repeat can't slip past to the raw index.
  const onThisPage = itemOnPage(
    pageId,
    sitePageItemTargets.of(itemType)(itemId),
  );
  const duplicate = resultRows<SitePageItem>(
    await tx.execute({
      args: clauseArgs(onThisPage),
      sql: `SELECT ${SELECT_COLS} FROM site_page_items${whereSql(onThisPage)}`,
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
    // Single-parent: the page must not already be nested elsewhere.
    if (pageEdges.some((e) => e.item_id === itemId)) return false;
    // Acyclic: nesting it here must not close a loop (self or ancestor).
    // The walk needs only the child → parent edge map — never a page row.
    const parentByChild = pageParentMapFromEdges(pageEdges);
    if (wouldCreateCycle({ parentByChild }, pageId, itemId)) {
      return false;
    }
  }
  const next = await sitePageItemOrder.next({
    scope: pageId,
    transaction: tx,
  });
  await tx.execute({
    args: [pageId, itemType, itemId, next],
    sql: "INSERT INTO site_page_items (page_id, item_type, item_id, sort_order) VALUES (?, ?, ?, ?)",
  });
  return true;
};

export const addPageItem: PageItemChange<boolean> = pageItemChange(
  addPageItemInTransaction,
);

const itemDeleteStatement = (
  pageId: number,
  itemType: SitePageItemType,
  itemId: number,
): SqlStatement =>
  deleteWhere("site_page_items")(
    itemOnPage(pageId, sitePageItemTargets.of(itemType)(itemId)),
  );

const runItemDelete = async (
  run: (statement: SqlStatement) => Promise<unknown>,
  pageId: number,
  itemType: SitePageItemType,
  itemId: number,
): Promise<void> => {
  await run(itemDeleteStatement(pageId, itemType, itemId));
};

/** Remove one item from a page (by its composite key). */
export const removePageItem: PageItemChange<void> = pageItemChange(
  (transaction, ...args) =>
    runItemDelete((statement) => transaction.execute(statement), ...args),
  (...args) =>
    runItemDelete(
      (statement) => execute(statement.sql, statement.args),
      ...args,
    ),
);

/**
 * Delete a page and every edge touching it — its own items, any edge naming it
 * as a child `page`, and its image links — in one batch (single implicit
 * transaction), so a partial failure can never leave a dangling edge or image
 * use. Former children become roots; the images themselves stay in the library
 * (only the uses are pruned, as with listing/group/news deletion).
 */
export const deleteSitePageWithEdges = (pageId: number): Promise<void> =>
  executeBatch([
    { args: [pageId], sql: "DELETE FROM site_page_items WHERE page_id = ?" },
    clearItemEdgesStatement(sitePageItemTargets.of("page")(pageId)),
    clearImageUsesForItemStatement(imageUseTargets.of("page")(pageId)),
    { args: [pageId], sql: "DELETE FROM site_pages WHERE id = ?" },
  ]);
