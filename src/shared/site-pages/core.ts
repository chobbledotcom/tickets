/**
 * The pure, total functional core of the site-pages feature (pages.md,
 * "Functional core"). Every function here is deterministic and side-effect
 * free: plain data in → plain data out. No DB, no crypto, no JSX, no `Request`.
 *
 * The acquire ring loads rows + resolves leaf targets; this core turns them
 * into the forest, the nav view model, reorder plans, and the cycle/eligibility
 * decisions; the apply ring writes or renders. All the logic worth testing
 * lives here and is exercised by plain-object unit tests.
 */

import type {
  Forest,
  NavModel,
  NavNode,
  TargetKey,
  TargetMap,
} from "#shared/site-pages/types.ts";
import type {
  SitePageItem,
  SitePageItemType,
  SitePageNavRow,
} from "#shared/types.ts";

/** Mint the composite key for a target. The one place keys are formed. */
export const targetKey = (type: SitePageItemType, id: number): TargetKey =>
  `${type}:${id}`;

/** Parse a {@link TargetKey} back into its parts. */
export const parseTargetKey = (
  key: TargetKey,
): { type: SitePageItemType; id: number } => {
  const idx = key.indexOf(":");
  return {
    id: Number(key.slice(idx + 1)),
    type: key.slice(0, idx) as SitePageItemType,
  };
};

const pageKey = (id: number): TargetKey => targetKey("page", id);

/** Order comparator for pages/items: by `sort_order`, then a stable tiebreak. */
const bySortThen =
  <T>(sortOf: (t: T) => number, tieOf: (t: T) => number) =>
  (a: T, b: T): number =>
    sortOf(a) - sortOf(b) || tieOf(a) - tieOf(b);

const bySortOrderThenId = bySortThen<SitePageNavRow>(
  (p) => p.sort_order,
  (p) => p.id,
);

const itemOrder = bySortThen<SitePageItem>(
  (i) => i.sort_order,
  (i) => i.item_id,
);

/**
 * Build the adjacency model from raw rows. Sorts the inputs itself, so it is
 * independent of DB row order (tests feed unordered fixtures). A page is a root
 * iff no `page`-type edge names it as a child.
 */
export const buildForest = (
  pages: readonly SitePageNavRow[],
  items: readonly SitePageItem[],
): Forest => {
  const byId = new Map(pages.map((p) => [p.id, p]));

  const itemsByPage = new Map<number, SitePageItem[]>();
  for (const item of items) {
    const list = itemsByPage.get(item.page_id);
    if (list) list.push(item);
    else itemsByPage.set(item.page_id, [item]);
  }
  for (const list of itemsByPage.values()) list.sort(itemOrder);

  // First page-parent wins (the app guarantees at most one — see N3).
  const parentByChild = new Map<number, number>();
  for (const [pageId, list] of itemsByPage) {
    for (const item of list) {
      if (item.item_type === "page" && !parentByChild.has(item.item_id)) {
        parentByChild.set(item.item_id, pageId);
      }
    }
  }

  const rootIds = [...byId.values()]
    .filter((p) => !parentByChild.has(p.id))
    .sort(bySortOrderThenId)
    .map((p) => p.id);

  return { byId, itemsByPage, parentByChild, rootIds };
};

/**
 * The ancestor page ids of `pageId`, root-first, excluding the node itself.
 * Uses a visited guard so a corrupt cyclic edge set throws loudly rather than
 * looping — the app guarantees an acyclic tree (N3/N4), so a cycle here is an
 * impossible state to surface, not to absorb.
 */
export const ancestorsOf = (forest: Forest, pageId: number): number[] => {
  const chain: number[] = [];
  const seen = new Set<number>([pageId]);
  let cursor = forest.parentByChild.get(pageId);
  while (cursor !== undefined) {
    if (seen.has(cursor)) {
      throw new Error(`site_pages: cycle detected above page ${pageId}`);
    }
    seen.add(cursor);
    chain.push(cursor);
    cursor = forest.parentByChild.get(cursor);
  }
  return chain.reverse();
};

/** The descendant page ids of `pageId` (excluding itself). */
export const descendantsOf = (forest: Forest, pageId: number): Set<number> => {
  const out = new Set<number>();
  const walk = (id: number): void => {
    for (const item of forest.itemsByPage.get(id) ?? []) {
      if (item.item_type !== "page" || out.has(item.item_id)) continue;
      out.add(item.item_id);
      walk(item.item_id);
    }
  };
  walk(pageId);
  return out;
};

/**
 * Would placing `candidatePageId` under `parentPageId` create a cycle? It does
 * iff the candidate is the parent itself or an ancestor of the parent (adding
 * the edge would close a loop back to the candidate — N4). A descendant is *not*
 * a cycle risk here; it's blocked by the single-parent rule instead.
 */
export const wouldCreateCycle = (
  forest: Forest,
  parentPageId: number,
  candidatePageId: number,
): boolean =>
  candidatePageId === parentPageId ||
  ancestorsOf(forest, parentPageId).includes(candidatePageId);

/**
 * The pages that may be added as a child of `currentPageId`: unparented pages
 * (single-parent rule) that aren't the page itself and wouldn't form a cycle.
 * Ordered by `(sort_order, id)` for a stable picker.
 */
export const eligibleChildPages = (
  forest: Forest,
  currentPageId: number,
): SitePageNavRow[] =>
  [...forest.byId.values()]
    .filter(
      (p) =>
        p.id !== currentPageId &&
        !forest.parentByChild.has(p.id) &&
        !wouldCreateCycle(forest, currentPageId, p.id),
    )
    .sort(bySortOrderThenId);

/** The next `sort_order` to append after `existing` (max + 1; 0 when empty). */
export const nextSortOrder = (existing: readonly number[]): number =>
  existing.length === 0 ? 0 : Math.max(...existing) + 1;

/**
 * Plan an adjacent-swap reorder: the two keys whose `sort_order` to exchange to
 * move `target` one step in `dir`, or null at a boundary / when absent. One
 * function both root-page and within-page reorder flow through; the apply ring
 * executes the swap.
 */
export const planReorder = (
  orderedKeys: readonly TargetKey[],
  target: TargetKey,
  dir: "up" | "down",
): readonly [TargetKey, TargetKey] | null => {
  const idx = orderedKeys.indexOf(target);
  if (idx === -1) return null;
  const neighbor = orderedKeys[idx + (dir === "up" ? -1 : 1)];
  return neighbor === undefined ? null : [target, neighbor];
};

/** Slugs that would shadow a core route or nav label — rejected for a page. */
const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "admin",
  "api",
  "contact",
  "home",
  "listings",
  "order",
  "page",
  "terms",
  "ticket",
]);

/** Is `slug` a reserved word a page must not take (nav/route confusion)? */
export const isReservedSlug = (slug: string): boolean =>
  RESERVED_SLUGS.has(slug.trim().toLowerCase());

// ─── Nav model ──────────────────────────────────────────────────

/** Find the page that anchors the contextual nav for `current`. For a page
 * target it's the page itself; for a leaf it's the containing page, tie-broken
 * deterministically by the parent page's `(sort_order, id)` (N6). Null when the
 * target isn't on the tree. */
const anchorPageId = (
  forest: Forest,
  current: TargetKey | null,
): number | null => {
  if (current === null) return null;
  const { type, id } = parseTargetKey(current);
  if (type === "page") return forest.byId.has(id) ? id : null;
  const parents: SitePageNavRow[] = [];
  for (const [pid, list] of forest.itemsByPage) {
    if (list.some((i) => i.item_type === type && i.item_id === id)) {
      const row = forest.byId.get(pid);
      if (row) parents.push(row);
    }
  }
  return parents.sort(bySortOrderThenId)[0]?.id ?? null;
};

/**
 * Build the public nav view model: root page nodes (shallow — the top row), the
 * stacked submenu levels for the active chain (root-first), and which root to
 * highlight. Pure: forest + resolved leaves + "where am I" → the whole model.
 *
 * Active is marked **per level**, not by a global key: at most one node per
 * level is active (the next chain page, or — in the deepest level — the current
 * leaf). A leaf attached to several pages therefore highlights only the
 * occurrence on the chosen N6 path, never every occurrence of its `listing:id`.
 */
export const buildNavModel = (
  forest: Forest,
  targets: TargetMap,
  current: TargetKey | null,
): NavModel => {
  const anchor = anchorPageId(forest, current);
  const chain = anchor === null ? [] : [...ancestorsOf(forest, anchor), anchor];
  const activeRootId = chain[0] ?? null;
  const deepest = chain.length - 1;
  const currentIsLeaf =
    current !== null && parseTargetKey(current).type !== "page";

  // The single node key to highlight in level `i`: the next chain page for the
  // levels above the deepest, and the current leaf in the deepest level itself.
  const activeKeyAt = (i: number): TargetKey | null =>
    i < deepest
      ? pageKey(chain[i + 1] as number)
      : currentIsLeaf
        ? current
        : null;

  const leafNode = (item: SitePageItem, active: boolean): NavNode | null => {
    const key = targetKey(item.item_type, item.item_id);
    const t = targets.get(key);
    return t
      ? {
          active,
          children: [],
          href: t.href,
          key,
          label: t.label,
          live: t.live,
        }
      : null;
  };

  const pageNode = (id: number, active: boolean): NavNode | null => {
    const row = forest.byId.get(id);
    return row
      ? {
          active,
          children: [],
          href: `/page/${row.slug}`,
          key: pageKey(id),
          label: row.name,
          live: true,
        }
      : null;
  };

  // Exhaustive per-type dispatch (schema spine): leaves resolve from the
  // TargetMap; a page resolves from the forest. Every node is shallow — the
  // levels carry the depth, not nested children.
  const NODE_BUILDERS: Record<
    SitePageItemType,
    (item: SitePageItem, active: boolean) => NavNode | null
  > = {
    group: leafNode,
    listing: leafNode,
    page: (item, active) => pageNode(item.item_id, active),
  };

  const levelOf = (pageId: number, i: number): NavNode[] => {
    const activeKey = activeKeyAt(i);
    return (forest.itemsByPage.get(pageId) ?? [])
      .map((item) => {
        const key = targetKey(item.item_type, item.item_id);
        return NODE_BUILDERS[item.item_type](item, key === activeKey);
      })
      .filter((n): n is NavNode => n !== null);
  };

  return {
    activeRootId,
    rootPageNodes: forest.rootIds
      .map((id) => pageNode(id, id === activeRootId))
      .filter((n): n is NavNode => n !== null),
    submenuLevels: chain.map(levelOf),
  };
};
