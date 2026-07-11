/**
 * Pure data shapes for the site-pages functional core. This module imports
 * nothing but domain types — every
 * value here is plain, serialisable data that the pure functions in `core.ts`
 * transform. No DB, no crypto, no JSX.
 */

import type {
  SitePageItem,
  SitePageItemType,
  SitePageNavRow,
} from "#shared/types.ts";

/** A stable string key for any nav target — the composite `(type, id)` the
 * whole system is keyed on. `targetKey()` in `core.ts` mints it; everything
 * compares by it. */
export type TargetKey = `${SitePageItemType}:${number}`;

/** A leaf's resolved presentation + reachability, produced by the acquire ring
 * (listing/group liveness classification lands here as plain data). */
export interface ResolvedTarget {
  href: string;
  label: string;
  /** false ⇒ the item renders as text, never a link (never a dead link). */
  live: boolean;
}

/** Resolved leaves keyed by {@link TargetKey}. Page targets are derived from the
 * forest itself, so only `listing:`/`group:` keys need appear here. */
export type TargetMap = ReadonlyMap<TargetKey, ResolvedTarget>;

/** The adjacency model the core builds once from the raw rows and reuses.
 * Pure and order-independent (built by sorting the inputs itself). */
export interface Forest {
  /** page id → its nav row. */
  byId: ReadonlyMap<number, SitePageNavRow>;
  /** page id → its items, in `sort_order`. */
  itemsByPage: ReadonlyMap<number, readonly SitePageItem[]>;
  /** child page id → parent page id (only `item_type: "page"` edges). */
  parentByChild: ReadonlyMap<number, number>;
  /** ids of pages with no page-parent, ordered by `(sort_order, id)`. */
  rootIds: readonly number[];
}

/** A node in the rendered nav tree — nothing DB-shaped. */
export interface NavNode {
  /** on the current node's ancestor chain (incl. the current node). */
  active: boolean;
  children: readonly NavNode[];
  href: string;
  key: TargetKey;
  label: string;
  /** false ⇒ render as text, not a link. */
  live: boolean;
}

/** One stacked submenu level: the items of one active-chain page. */
export interface NavLevel {
  /** The name of the page whose items this level lists — the mobile bar's
   * accessible label. */
  label: string;
  /** The level's nodes, in edge order. Never empty — an item-less level is
   * omitted from the model entirely (nothing to render). */
  nodes: readonly NavNode[];
}

/** The full view model the templates render. */
export interface NavModel {
  /** Which root page to highlight, or null when off-tree. */
  activeRootId: number | null;
  /** The current PAGE target's own items — what `/page/:slug` lists below its
   * content. Empty for a leaf/off-tree/absent current. */
  currentChildren: readonly NavNode[];
  /** Root page nodes, ordered — spliced between Listings and Contact. */
  rootPageNodes: readonly NavNode[];
  /** Stacked ancestor sibling-sets for the active chain, root-first, each
   * labelled by its page; empty when the current target has no parent page. */
  submenuLevels: readonly NavLevel[];
}
