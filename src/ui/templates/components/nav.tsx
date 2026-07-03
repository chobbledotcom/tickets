/**
 * The one leveled navigation both site navigations (admin and public) render
 * through: a plain node/level data model plus a single renderer that emits the
 * stacked-bars-on-mobile / pinned-sidebar-on-desktop pattern from the same CSS
 * (`admin-nav--mobile` / `admin-nav--desktop`; the `.admin-nav-group` wrapper
 * is what the desktop grid pins left).
 *
 * Each viewport keeps its own correctly-ordered DOM, so tab/reading order
 * always matches what's shown — no CSS `order` reshuffling:
 *
 *  - a desktop sidebar, where the submenu levels nest recursively beneath the
 *    active node of the level above, and
 *  - mobile bars, where each level follows the top-level row as its own bar.
 */

/** One nav entry. The public site-pages `NavNode` is structurally one of
 * these; the admin nav lifts its link schema into them. */
export interface LeveledNavNode {
  href: string;
  label: string;
  /** false ⇒ render as text, not a link (never a dead link). */
  live: boolean;
  /** Highlighted; on desktop the next submenu level nests beneath it. */
  active: boolean;
}

/** One stacked submenu level: one mobile bar / one desktop nesting step. */
export interface LeveledNavLevel {
  /** The level's accessible name (the mobile bar's aria-label). */
  label: string;
  nodes: readonly LeveledNavNode[];
}

/** A node as a link — or plain text when its target isn't reachable by the
 * viewer (never render a dead or forbidden link). */
export const NodeLink = ({ node }: { node: LeveledNavNode }): JSX.Element =>
  node.live ? (
    <a class={node.active ? "active" : undefined} href={node.href}>
      {node.label}
    </a>
  ) : (
    <span>{node.label}</span>
  );

/** Flat `<li>` list of nodes. `nested` supplies a node's extra children (the
 * desktop level nesting beneath the active node); omit it for a plain list. */
export const nodeLis = (
  nodes: readonly LeveledNavNode[],
  nested: (node: LeveledNavNode) => JSX.Element | null = () => null,
): JSX.Element[] =>
  nodes.map((node) => (
    <li>
      <NodeLink node={node} />
      {nested(node)}
    </li>
  ));

/** Desktop: the submenu levels nested recursively — level `depth` renders
 * beneath the active node of the level above (the next step on the active
 * chain), indenting one step per level. The model never carries an empty
 * level, so every rendered `<ul>` has children. */
const DesktopLevels = ({
  levels,
  depth,
}: {
  levels: readonly LeveledNavLevel[];
  depth: number;
}): JSX.Element | null =>
  depth >= levels.length ? null : (
    <ul class="admin-subnav">
      {nodeLis(levels[depth]!.nodes, (node) =>
        node.active ? (
          <DesktopLevels depth={depth + 1} levels={levels} />
        ) : null,
      )}
    </ul>
  );

/** One mobile nav bar (the top-level row, or a submenu level beneath it), with
 * an accessible name so screen-reader users can tell the stacked bars apart. */
const mobileNavBar = (label: string, lis: JSX.Element[]): JSX.Element => (
  <nav aria-label={label} class="admin-nav admin-nav--mobile">
    <ul>{lis}</ul>
  </nav>
);

/** The desktop sidebar shell around the top-level `<li>`s. */
const desktopNavShell = (
  label: string,
  lis: JSX.Element[],
  id?: string,
): JSX.Element => (
  <nav aria-label={label} class="admin-nav admin-nav--desktop" id={id}>
    <ul>{lis}</ul>
  </nav>
);

/** Render one whole leveled navigation. `rootLis` builds the top-level row for
 * each viewport; its `nested` argument is the desktop nesting to hang beneath
 * the active root (always null on mobile), so callers that splice fixed links
 * around their nodes stay in control of the row. `id` is the admin nav's
 * `#main-nav` marker — the stylesheet reads it as "this is an admin page", so
 * the public nav must not pass one. The desktop sidebar and the mobile bars
 * share one wrapper so the desktop grid can pin it as a single sticky
 * left-hand column. */
export const leveledNav = (opts: {
  label: string;
  rootLis: (
    nested: (node: LeveledNavNode) => JSX.Element | null,
  ) => JSX.Element[];
  levels: readonly LeveledNavLevel[];
  id?: string;
}): JSX.Element => (
  <div class="admin-nav-group">
    {desktopNavShell(
      opts.label,
      opts.rootLis((node) =>
        node.active ? <DesktopLevels depth={0} levels={opts.levels} /> : null,
      ),
      opts.id,
    )}
    {mobileNavBar(
      opts.label,
      opts.rootLis(() => null),
    )}
    {opts.levels.map((level) =>
      mobileNavBar(level.label, nodeLis(level.nodes)),
    )}
  </div>
);
