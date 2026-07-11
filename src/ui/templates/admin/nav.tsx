/**
 * Shared admin navigation.
 *
 * AdminNav builds the whole menu for the current page from one schema
 * (`#shared/admin-pages.ts`): the top-level links, plus — for the section the
 * page belongs to — that section's sub-nav. The pure schema folds decide which
 * links/sections are visible for the viewer's role and feature flags; this
 * module evaluates those flags at render time, resolves i18n label keys, and
 * renders through the shared `leveledNav` renderer the public nav uses.
 */

import { t } from "#i18n";
import { isBuilderEnabled } from "#routes/admin/builder.ts";
import {
  type NavLink,
  type NavSection,
  visibleSections,
  visibleTopLevel,
} from "#shared/admin-pages.ts";
import type { AdminSurfaceContext } from "#shared/admin-surface/definitions.ts";
import { settings } from "#shared/db/settings.ts";
import {
  getReadOnlyCutoffIso,
  getRenewalUrl,
  isReadOnly,
  isReadOnlyWarning,
} from "#shared/env.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { isStorageEnabled } from "#shared/storage.ts";
import { isSupportEnabled } from "#shared/support.ts";
import type { AdminLevel, AdminSession } from "#shared/types.ts";
import { markAdminFooter } from "#templates/admin/footer.tsx";
import { SettingsNagBanner } from "#templates/admin/settings-nag-banner.tsx";
import {
  type LeveledNavLevel,
  type LeveledNavNode,
  leveledNav,
  nodeLis,
} from "#templates/components/nav.tsx";

/**
 * What the admin nav should mark active for the current page.
 *
 * - A plain route string — the page *is* this route: a section's landing page
 *   (`/admin/attendees`), an "Add X" create page (`/admin/attendees/new`), or a
 *   settings/site sub-page (`/admin/privacy`). The nav highlights the matching
 *   link and, when the route is a section's landing route or one of its sub-nav
 *   items, opens that section's sub-nav (current sub-page highlighted).
 * - `{ section }` — the page merely lives *within* a section: a detail or child
 *   view of one item (one attendee, one listing, the add-note form). The nav
 *   highlights the section's top-level link but never opens its sub-nav.
 *
 * The `{ section }` form is the *only* way to highlight a section without also
 * surfacing its sub-nav. It exists because a single-item page is not the
 * section's landing page, so the section's "Add" create link has no business
 * appearing beside it — and the sub-nav resolves purely from the active route,
 * so a detail page that reuses the section's landing route as a bare `active`
 *   string (to get the top link highlighted) would silently re-trigger that "Add"
 *   affordance. Naming the section explicitly makes that impossible to do by
 *   accident: a section a page is *in* can never be mistaken for the section's
 *   landing route the page is *on*.
 */
export type NavActive = string | { readonly section: string };

/** The route to resolve highlighting from, for either `NavActive` shape. */
const activeRoute = (active: NavActive): string =>
  typeof active === "string" ? active : active.section;

/** True when a page is merely *within* a section (a single-item detail/child
 * page) rather than on a real section route — so it highlights the section's top
 * link but shows no sub-nav. */
const isWithinSection = (active: NavActive): boolean =>
  typeof active !== "string";

/** One navigation link (i18n label already resolved). */
interface NavItem {
  href: string;
  label: string;
}

/** Resolve a schema link's labelKey to a display label. */
const resolveLink = ({ href, labelKey }: NavLink): NavItem => ({
  href,
  label: t(labelKey),
});

/** The resolved menu for the active section: which top-level link to highlight,
 * an accessible name for its sub-nav, and its items. */
interface Section {
  items: NavItem[];
  /** Accessible name for this section's sub-nav (mobile) landmark. */
  label: string;
  /** Top-level link highlighted for this section (the page may live deeper). */
  topHref: string;
}

/** Resolve a schema section to a renderable section (labels resolved). */
const resolveSectionItems = (sec: NavSection): Section => ({
  items: sec.items.map(resolveLink),
  label: t(sec.labelKey),
  topHref: sec.topHref,
});

/** Render read-only or warning banner with optional renewal URL */
const renderReadOnlyBanner = (
  readOnly: boolean,
  warning: boolean,
  cutoffIso: string | null,
  renewalUrl: string | null,
): JSX.Element | null => {
  if (readOnly) {
    const link = renewalUrl
      ? ` — <a href="${renewalUrl}">${t("nav.readonly.renew")}</a>`
      : "";
    return (
      <Raw
        html={`<div class="read-only-banner">${t(
          "nav.readonly.banner",
        )}${link}</div>`}
      />
    );
  }
  if (warning) {
    const link = renewalUrl
      ? ` — <a href="${renewalUrl}">${t("nav.readonly.renew")}</a>`
      : "";
    const dateStr = new Date(String(cutoffIso)).toLocaleDateString();
    const msg = dateStr
      ? `${t("nav.readonly.expires", { date: dateStr })}${link}`
      : `${t("nav.readonly.expiring")}${link}`;
    return <Raw html={`<div class="read-only-banner-warning">${msg}</div>`} />;
  }
  return null;
};

/** Evaluate all feature flags once per nav render, producing the pure context
 * the schema folds consume. This is the thin IO shell around
 * `admin-pages.ts` — the schema knows nothing about settings, env, or storage. */
const navCtx = (
  adminLevel: AdminLevel,
  active: string,
): AdminSurfaceContext => ({
  active,
  adminLevel,
  builder: isBuilderEnabled(),
  hasLogistics: settings.hasLogistics,
  isReadOnly: isReadOnly(),
  showPublicSite: settings.showPublicSite,
  storage: isStorageEnabled(),
  support: isSupportEnabled(),
});

/** A section owns the active route when it's the section's landing link or one
 * of its sub-nav links (an "Add X" create page, a settings sub-page, …). */
const ownsActive = (candidate: Section, active: string): boolean =>
  candidate.topHref === active ||
  candidate.items.some((item) => item.href === active);

/** Resolve which section (and sub-nav) the active route belongs to. Pages pass
 * their own route as `active`: the section landing route (e.g. /admin/settings)
 * resolves the section so its top-level link highlights, and a deeper route
 * (a create page like /admin/listing/new, or a sub-page like /admin/privacy)
 * additionally highlights that sub-nav link — see `sectionLevels`. */
const resolveSection = (
  active: string,
  ctx: AdminSurfaceContext,
): Section | null =>
  visibleSections(ctx)
    .map(resolveSectionItems)
    .find((candidate) => ownsActive(candidate, active)) ?? null;

/** Lift the plain link schema into leveled-nav nodes: every admin link is live
 * (the schema already omits links the viewer's role can't open), and `highlight`
 * marks the current route's link — the section's top-level link at the root
 * level, and the exact current sub-page (e.g. an "Add X") in its sub-nav. */
const toNodes = (items: NavItem[], highlight: string): LeveledNavNode[] =>
  items.map((item) => ({
    ...item,
    active: item.href === highlight,
    live: true,
  }));

/** The section's sub-nav as the model's submenu levels — one level, or none.
 *
 * A page deep in a section (a session list, a settings sub-page, a site editor
 * tab) renders with the *section's own route* as `active`, so we can't tell it
 * apart from the section landing page by `active` alone. Highlighting the
 * matching sub-item would then wrongly light the landing link on every such
 * page — so we only highlight a sub-item when `active` is more specific than
 * the section route (an "Add X" create page, or any page that declares its own
 * route). The section itself is already highlighted on the top-level bar. */
const sectionLevels = (
  sectionItems: Section | null,
  active: string,
): LeveledNavLevel[] => {
  if (!sectionItems) return [];
  const subHighlight = active === sectionItems.topHref ? "" : active;
  // Never repeat the section's own landing link inside its sub-nav — the
  // top-level bar already carries it, so the submenu shows only the pages
  // *within* the section (Add, Import, sub-pages). A "repeat" is the same
  // destination under the same name: we drop a sub-item only when it matches
  // the top-level link on both href AND label. That keeps a distinctly-named
  // landing tab (e.g. Site's "Homepage", which shares /admin/site but reads
  // differently) while removing true duplicates like Listings→Listings.
  const subItems = sectionItems.items.filter(
    (item) =>
      !(
        item.href === sectionItems.topHref && item.label === sectionItems.label
      ),
  );
  // The model never carries an empty level (every rendered <ul> must have
  // children), so a section left with no sub-pages — e.g. an "Add"-only
  // section in read-only mode — contributes no submenu at all.
  if (subItems.length === 0) return [];
  return [
    {
      label: sectionItems.label,
      nodes: toNodes(subItems, subHighlight),
    },
  ];
};

interface AdminNavProps {
  active: NavActive;
  session: AdminSession;
}

/**
 * Universal admin navigation - shown at the top of every admin page. It owns
 * the section sub-nav itself, derived from `active`, so pages only say which
 * route they are on. Users and Settings links are owner-only.
 */
export const AdminNav = ({ session, active }: AdminNavProps): JSX.Element => {
  // Flag this render as an admin page so the Layout emits the admin footer
  // (Chobble link, optional debug menu, and the logout button).
  markAdminFooter(session.adminLevel);
  const route = activeRoute(active);
  const ctx = navCtx(session.adminLevel, route);
  const activeSection = resolveSection(route, ctx);
  const highlight = activeSection?.topHref ?? route;
  const rootNodes = toNodes(visibleTopLevel(ctx).map(resolveLink), highlight);
  // A page merely *within* a section highlights its top link but shows no
  // sub-nav — the section's "Add" create link is not an affordance for a
  // single-item detail page.
  const levels = isWithinSection(active)
    ? []
    : sectionLevels(activeSection, route);
  return (
    <>
      {renderReadOnlyBanner(
        isReadOnly(),
        isReadOnlyWarning(),
        getReadOnlyCutoffIso(),
        getRenewalUrl(),
      )}
      {session.adminLevel === "owner" && (
        <SettingsNagBanner
          {...(session.settingsNagItems !== undefined
            ? { items: session.settingsNagItems }
            : {})}
        />
      )}
      {leveledNav({
        id: "main-nav",
        label: t("nav.admin"),
        levels,
        rootLis: (nested) => nodeLis(rootNodes, nested),
      })}
    </>
  );
};

/** Staff navigation for pages that agents can also open with their own header. */
export const StaffAdminNav = ({
  active,
  session,
}: AdminNavProps): JSX.Element | null =>
  session.adminLevel === "agent" ? null : (
    <AdminNav active={active} session={session} />
  );
