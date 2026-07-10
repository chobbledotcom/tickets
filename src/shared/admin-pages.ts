/**
 * Admin page & route schema — the single declarative source of truth for
 * every admin nav section: its landing route, the roles that may see it, the
 * feature flags that gate it, and its sub-nav links.
 *
 * The schema is pure data (with optional predicate functions over a
 * {@link NavCtx}). The impure shell (`nav.tsx`) evaluates the feature flags
 * at render time, builds a `NavCtx`, and calls the fold functions to get the
 * visible links/sections. Tests call the same folds with a hand-built
 * context — no IO, no re-derivation.
 *
 * The reference pattern: `LISTING_DEFAULT_FIELDS` + `resolveListingDefaults`
 * (`listing-defaults.ts`) — a typed data table with per-entry predicates, plus
 * one fold. Here the table is `ADMIN_NAV` and the folds are
 * {@link visibleTopLevel} and {@link visibleSections}.
 */

import {
  type AdminLevel,
  CONTENT_ADMIN_LEVELS,
  SITE_ADMIN_LEVELS,
  STAFF_ADMIN_LEVELS,
} from "#shared/types.ts";

/** Runtime feature flags and the active route, evaluated once per nav render.
 * Pure data — the schema's predicate functions receive this so the schema
 * itself stays free of IO. `adminLevel` is included so a predicate can vary
 * by role (e.g. Site is always visible to editors). */
export interface NavCtx {
  readonly adminLevel: AdminLevel;
  readonly isReadOnly: boolean;
  readonly storage: boolean;
  readonly builder: boolean;
  readonly support: boolean;
  readonly showPublicSite: boolean;
  readonly hasLogistics: boolean;
  /** The route the current page declares as its `active` value. */
  readonly active: string;
}

/** One resolved top-level link (before i18n label resolution). */
export interface NavLink {
  readonly href: string;
  readonly labelKey: string;
}

/** One resolved sub-nav link (before i18n label resolution). Sub-nav items
 * have the same shape as top-level links — both carry just an href and a
 * label key — so they share the {@link NavLink} type. */

/** One resolved section: a top-level link plus its visible sub-nav items. */
export interface NavSection {
  readonly topHref: string;
  readonly labelKey: string;
  readonly items: readonly NavLink[];
}

/** One sub-nav entry in the schema. */
interface SubNavDef {
  readonly href: string;
  readonly labelKey: string;
  /** "create" links drop out in read-only mode. Defaults to "link". */
  readonly kind?: "link" | "create";
  /** When false, the link is omitted entirely. */
  readonly visible?: (ctx: NavCtx) => boolean;
}

/** One nav entry in the schema: a top-level link with an optional sub-nav. */
interface SectionDef {
  /** The section's landing route (e.g. "/admin/listings"). */
  readonly basePath: string;
  /** i18n key for the section label. */
  readonly labelKey: string;
  /** Which roles may see this section. */
  readonly roles: readonly AdminLevel[];
  /** When false, the section is omitted from both the top-level bar and the
   * section list. Predicate has access to the full {@link NavCtx} so it can
   * vary by role (Site is always visible to editors) or by active route
   * (Site stays visible on its own pages even when the public site is off,
   * so the desktop sub-nav has a parent to nest under). */
  readonly visible?: (ctx: NavCtx) => boolean;
  /** Sub-nav entries. The first entry matching the basePath is the landing
   * link — it's used for section resolution but filtered from rendering
   * (via `sectionLevels` in nav.tsx) when its href AND label match the
   * section's. A sub-nav with a distinctly-named landing link (e.g. Site's
   * "Homepage") stays visible in the rendered sub-nav. */
  readonly subNav?: readonly SubNavDef[];
}

/** True when the active route is within the Site section. */
const isSiteRoute = (active: string): boolean =>
  active === "/admin/site" || active.startsWith("/admin/site/");

/**
 * The admin nav schema — one ordered list of sections and top-level-only
 * links. The order is the top-level render order (Home, Listings, Calendar,
 * …, Settings). Sections without `subNav` (Home, Ledger) are plain
 * top-level links. Sections with `subNav` additionally open a sub-nav when
 * active.
 *
 * Filtering this single list by role produces the correct order for every
 * role: editors see Listings, Groups, Images, Site (in that order), which
 * matches the hand-wired `editorTopLevelItems` it replaces.
 */
const ADMIN_NAV: readonly SectionDef[] = [
  {
    basePath: "/admin/",
    labelKey: "nav.public.home",
    roles: STAFF_ADMIN_LEVELS,
  },
  {
    basePath: "/admin/listings",
    labelKey: "terms.listings",
    roles: CONTENT_ADMIN_LEVELS,
    subNav: [
      { href: "/admin/listings", labelKey: "terms.listings" },
      { href: "/admin/listing/new", kind: "create", labelKey: "nav.sub.add" },
      { href: "/admin/catalog/import", labelKey: "nav.sub.import" },
    ],
  },
  {
    basePath: "/admin/calendar",
    labelKey: "nav.calendar",
    roles: STAFF_ADMIN_LEVELS,
    subNav: [
      { href: "/admin/calendar", labelKey: "nav.calendar" },
      {
        href: "/admin/deliveries",
        labelKey: "nav.deliveries",
        visible: (ctx) => ctx.hasLogistics,
      },
    ],
  },
  {
    basePath: "/admin/servicing",
    labelKey: "nav.servicing",
    roles: STAFF_ADMIN_LEVELS,
    subNav: [
      { href: "/admin/servicing", labelKey: "nav.servicing" },
      { href: "/admin/servicing/new", kind: "create", labelKey: "nav.sub.add" },
    ],
  },
  {
    basePath: "/admin/attendees",
    labelKey: "terms.attendees",
    roles: STAFF_ADMIN_LEVELS,
    subNav: [
      { href: "/admin/attendees", labelKey: "terms.attendees" },
      { href: "/admin/attendees/new", kind: "create", labelKey: "nav.sub.add" },
    ],
  },
  {
    basePath: "/admin/users",
    labelKey: "terms.users",
    roles: ["owner"],
    subNav: [
      { href: "/admin/users", labelKey: "terms.users" },
      { href: "/admin/user/new", kind: "create", labelKey: "nav.sub.invite" },
      { href: "/admin/sessions", labelKey: "nav.sub.sessions" },
      { href: "/admin/api-keys", labelKey: "nav.sub.api_keys" },
    ],
  },
  {
    basePath: "/admin/groups",
    labelKey: "terms.groups",
    roles: CONTENT_ADMIN_LEVELS,
    subNav: [
      { href: "/admin/groups", labelKey: "terms.groups" },
      { href: "/admin/groups/new", kind: "create", labelKey: "nav.sub.add" },
    ],
  },
  {
    basePath: "/admin/images",
    labelKey: "terms.images",
    roles: CONTENT_ADMIN_LEVELS,
    subNav: [
      { href: "/admin/images", labelKey: "terms.images" },
      { href: "/admin/images/new", kind: "create", labelKey: "nav.sub.add" },
    ],
    visible: (ctx) => ctx.storage,
  },
  {
    basePath: "/admin/modifiers",
    labelKey: "terms.modifiers",
    roles: STAFF_ADMIN_LEVELS,
    subNav: [
      { href: "/admin/modifiers", labelKey: "terms.modifiers" },
      { href: "/admin/modifiers/new", kind: "create", labelKey: "nav.sub.add" },
    ],
  },
  {
    basePath: "/admin/ledger",
    labelKey: "nav.ledger",
    roles: ["owner"],
  },
  {
    basePath: "/admin/site",
    labelKey: "nav.site",
    roles: SITE_ADMIN_LEVELS,
    subNav: [
      { href: "/admin/site", labelKey: "site.sub_nav.homepage" },
      { href: "/admin/site/contact", labelKey: "site.sub_nav.contact" },
      { href: "/admin/site/order", labelKey: "site.sub_nav.order" },
      { href: "/admin/site/pages", labelKey: "nav.site.pages" },
      { href: "/admin/site/news", labelKey: "nav.site.news" },
    ],
    visible: (ctx) =>
      ctx.adminLevel === "editor" ||
      ctx.showPublicSite ||
      isSiteRoute(ctx.active),
  },
  {
    basePath: "/admin/settings",
    labelKey: "nav.settings",
    roles: ["owner"],
    subNav: [
      { href: "/admin/settings", labelKey: "nav.sub.settings" },
      {
        href: "/admin/listing-defaults",
        labelKey: "nav.sub.listing_defaults",
      },
      { href: "/admin/settings/statuses", labelKey: "nav.sub.statuses" },
      { href: "/admin/privacy", labelKey: "nav.sub.privacy" },
      { href: "/admin/questions", labelKey: "terms.questions" },
      { href: "/admin/logistics", labelKey: "nav.logistics" },
      { href: "/admin/emails", labelKey: "nav.emails" },
      { href: "/admin/holidays", labelKey: "terms.holidays" },
      {
        href: "/admin/built-sites",
        labelKey: "nav.built_sites",
        visible: (ctx) => ctx.builder,
      },
      { href: "/admin/settings-advanced", labelKey: "nav.sub.advanced" },
      { href: "/admin/backup", labelKey: "nav.sub.backups" },
      { href: "/admin/update", labelKey: "nav.sub.updates" },
      { href: "/admin/debug", labelKey: "nav.sub.debug" },
      {
        href: "/admin/support",
        labelKey: "nav.support",
        visible: (ctx) => ctx.support,
      },
    ],
  },
];

/** True when a section is visible for the given role and context. */
const sectionVisible = (def: SectionDef, ctx: NavCtx): boolean =>
  def.roles.includes(ctx.adminLevel) && (!def.visible || def.visible(ctx));

/** The visible sub-nav items for a section (after read-only and flag
 * filtering). The landing link is always included (it has no `kind` or
 * `visible` predicate) so section resolution can still match it. */
const visibleSubItems = (
  subNav: readonly SubNavDef[],
  ctx: NavCtx,
): NavLink[] => {
  const items: NavLink[] = [];
  for (const item of subNav) {
    if (item.kind === "create" && ctx.isReadOnly) continue;
    if (item.visible && !item.visible(ctx)) continue;
    items.push({ href: item.href, labelKey: item.labelKey });
  }
  return items;
};

/**
 * The top-level nav links visible to the current viewer, in render order.
 * The caller resolves each `labelKey` to a display label via `t(labelKey)`.
 */
export const visibleTopLevel = (ctx: NavCtx): NavLink[] =>
  ADMIN_NAV.filter((def) => sectionVisible(def, ctx)).map((def) => ({
    href: def.basePath,
    labelKey: def.labelKey,
  }));

/**
 * The sections that have at least one visible sub-nav item, for the current
 * viewer. Used by `resolveSection` to find which section owns the active
 * route — only one section's sub-nav is ever open at a time. A section whose
 * only visible item is its landing link (e.g. Calendar when logistics is
 * off) passes this filter but renders no sub-nav (the landing link is
 * filtered from display by `sectionLevels` in nav.tsx). */
export const visibleSections = (ctx: NavCtx): NavSection[] => {
  const sections: NavSection[] = [];
  for (const def of ADMIN_NAV) {
    if (!def.subNav || !sectionVisible(def, ctx)) continue;
    sections.push({
      items: visibleSubItems(def.subNav, ctx),
      labelKey: def.labelKey,
      topHref: def.basePath,
    });
  }
  return sections;
};

/** A section's "create" link — the "Add X" or "Invite" action that lives in a
 * section's sub-nav and drops out in read-only mode. Exposed so tests and the
 * read-only pattern list can iterate the full set without re-deriving it. */
export interface CreateLinkSection {
  /** The section's landing route (e.g. "/admin/listings"). */
  readonly sectionPath: string;
  /** Which roles may see this section (and thus its create link). */
  readonly roles: readonly AdminLevel[];
  /** The create link's href (e.g. "/admin/listing/new"). */
  readonly createHref: string;
  /** The create link's i18n label key (e.g. "nav.sub.add"). */
  readonly createLabelKey: string;
  /** True when the section itself is feature-flag-gated (e.g. Images requires
   * storage). Tests that don't enable the flag should skip these — they have
   * dedicated tests that do. */
  readonly featureGated: boolean;
}

/** Every "create" link in the schema — the "Add X" / "Invite" links that
 * drop out in read-only mode. Exposed so tests and the read-only GET pattern
 * list can derive the full set from the schema instead of hand-typing it. */
export const createLinkSections = (): CreateLinkSection[] =>
  ADMIN_NAV.flatMap((def) =>
    (def.subNav ?? [])
      .filter((item) => item.kind === "create")
      .map((item) => ({
        createHref: item.href,
        createLabelKey: item.labelKey,
        featureGated: def.visible !== undefined,
        roles: def.roles,
        sectionPath: def.basePath,
      })),
  );
