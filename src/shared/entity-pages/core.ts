/**
 * Entity pages — the pure core of the tabbed admin "edit X" framework.
 * The impure shell (`#routes/admin/entity-pages.ts`)
 * evaluates each tab's visibility predicate once and hands the resulting
 * plain {@link TabState} list to these functions, so tab resolution and
 * strip building are total data-in/data-out functions with no entity type,
 * session, or IO in sight.
 */

import { filter, map, pipe } from "#fp";
import type { SafeHtml } from "#jsx/jsx-runtime.ts";

/** One tab after its visibility predicate has been evaluated. */
export interface TabState {
  labelKey: string;
  /** URL segment under the entity's base path; "" is the default tab. */
  slug: string;
  /** Whether the current viewer may see this tab. A hidden tab is absent
   * from the strip AND 404s when named directly — visibility here is
   * authorization, not decoration. */
  visible: boolean;
}

/** One rendered tab-strip link. */
export interface TabLink {
  active: boolean;
  href: string;
  labelKey: string;
}

/** The canonical URL of a tab — the one place tab URLs are minted. */
export const tabPath = (basePath: string, slug: string): string =>
  slug === "" ? basePath : `${basePath}/${slug}`;

const visibleOnly = filter((tab: TabState) => tab.visible);

/** Optional controls flanking a page's title: one before the `<h1>`'s text,
 * one after it (a record page's previous/next pager, say). Null renders
 * nothing on that side. */
export interface FlankingNav {
  after: SafeHtml | null;
  before: SafeHtml | null;
}

/** The first item of `items`, or null when the list holds none. */
const firstOf = <Item>(items: readonly Item[]): Item | null => {
  for (const item of items) return item;
  return null;
};

/**
 * The neighbouring items of the one `isCurrent` names, with both ends of
 * the list wrapping around — a pager built from them never falls off the
 * list. A side is null when the current item is missing from the list or is
 * its only item: that side has no neighbour to point at, so a pager renders
 * no arrow for it.
 */
export const wrapAroundNeighbours = <Item>(
  list: readonly Item[],
  isCurrent: (item: Item) => boolean,
): { next: Item | null; previous: Item | null } => {
  let current: Item | undefined;
  const beforeCurrent: Item[] = [];
  const afterCurrent: Item[] = [];
  for (const item of list) {
    // Everything collected before the current item is found walks before it.
    if (current === undefined && isCurrent(item)) {
      current = item;
    } else {
      (current === undefined ? beforeCurrent : afterCurrent).push(item);
    }
  }
  // A current item the list does not hold has no neighbours: no walk starts
  // beside it.
  if (current === undefined) return { next: null, previous: null };
  return {
    next: firstOf(afterCurrent) ?? firstOf(beforeCurrent),
    previous:
      firstOf([...beforeCurrent].reverse()) ??
      firstOf([...afterCurrent].reverse()),
  };
};

/**
 * Resolve which tab a request lands on. A bare entity URL (requested "")
 * lands on the viewer's FIRST visible tab — role-aware, so a viewer whose
 * role hides the default tab still lands somewhere legal. A named slug must
 * match a visible tab exactly; anything else (unknown slug, hidden tab, no
 * visible tabs at all) resolves to null, which the shell turns into a 404.
 */
export const resolveTabSlug = (
  tabs: readonly TabState[],
  requested: string,
): string | null => {
  const visible = visibleOnly([...tabs]);
  if (requested === "") return visible[0]?.slug ?? null;
  return visible.find((tab) => tab.slug === requested)?.slug ?? null;
};

/** The strip links for a viewer: visible tabs only, active one marked. */
export const tabLinks = (
  tabs: readonly TabState[],
  basePath: string,
  activeSlug: string,
): TabLink[] =>
  pipe(
    visibleOnly,
    map((tab: TabState) => ({
      active: tab.slug === activeSlug,
      href: tabPath(basePath, tab.slug),
      labelKey: tab.labelKey,
    })),
  )([...tabs]);

/** Split an action list into the plain set and the danger zone, preserving
 * order within each. */
export const splitActions = <A extends { danger?: boolean }>(
  actions: readonly A[],
): { plain: A[]; danger: A[] } => ({
  danger: filter((action: A) => action.danger === true)([...actions]),
  plain: filter((action: A) => action.danger !== true)([...actions]),
});
