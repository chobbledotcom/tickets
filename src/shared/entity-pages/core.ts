/**
 * Entity pages — the pure core of the tabbed admin "edit X" framework
 * (edit-pages.md). The impure shell (`#routes/admin/entity-pages.ts`)
 * evaluates each tab's visibility predicate once and hands the resulting
 * plain {@link TabState} list to these functions, so tab resolution and
 * strip building are total data-in/data-out functions with no entity type,
 * session, or IO in sight.
 */

import { filter, map, pipe } from "#fp";

/** One tab after its visibility predicate has been evaluated. */
export interface TabState {
  /** URL segment under the entity's base path; "" is the default tab. */
  slug: string;
  /** Locale key for the strip label. */
  labelKey: string;
  /** Whether the current viewer may see this tab. A hidden tab is absent
   * from the strip AND 404s when named directly — visibility here is
   * authorization, not decoration. */
  visible: boolean;
}

/** One rendered tab-strip link. */
export interface TabLink {
  href: string;
  labelKey: string;
  active: boolean;
}

/** The canonical URL of a tab — the one place tab URLs are minted. */
export const tabPath = (basePath: string, slug: string): string =>
  slug === "" ? basePath : `${basePath}/${slug}`;

const visibleOnly = filter((tab: TabState) => tab.visible);

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
