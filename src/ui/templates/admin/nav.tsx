/**
 * Shared admin navigation.
 *
 * AdminNav builds the whole menu for the current page from one schema: the
 * top-level links, plus — for the section the page belongs to — that section's
 * sub-nav. The schema is lifted into the shared leveled-nav model and rendered
 * by the same `leveledNav` renderer the public nav uses (the desktop sidebar
 * with nested levels, and the stacked mobile bars).
 */

import { compact } from "#fp";
import { t } from "#i18n";
import { isBuilderEnabled } from "#routes/admin/builder.ts";
import { settings } from "#shared/db/settings.ts";
import {
  getReadOnlyCutoffIso,
  getRenewalUrl,
  isReadOnly,
  isReadOnlyWarning,
} from "#shared/env.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { isSupportEnabled } from "#shared/support.ts";
import type { AdminSession } from "#shared/types.ts";
import { markAdminFooter } from "#templates/admin/footer.tsx";
import { SettingsNagBanner } from "#templates/admin/settings-nag-banner.tsx";
import {
  type LeveledNavLevel,
  type LeveledNavNode,
  leveledNav,
  nodeLis,
} from "#templates/components/nav.tsx";

/** One navigation link. */
interface NavItem {
  href: string;
  label: string;
}

/** The resolved menu for the active section: which top-level link to highlight,
 * an accessible name for its sub-nav, and its items. */
interface Section {
  /** Top-level link highlighted for this section (the page may live deeper). */
  topHref: string;
  /** Accessible name for this section's sub-nav (mobile) landmark. */
  label: string;
  items: NavItem[];
}

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
        html={`<div class="read-only-banner">${t("nav.readonly.banner")}${link}</div>`}
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

/** A section's index link paired with its "Add X" sibling — the repeated
 * two-item shape every top-level section with its own create page uses
 * (Listings, Groups, Attendees, Modifiers, Servicing, Users), so the pair is
 * built once instead of hand-typed at every call site. The "Add X" sibling
 * drops out in read-only mode, matching every other create affordance's own
 * page (the dashboard's Add Listing button, the Modifiers page's Add
 * Modifier button, …) — a nav link must not offer a create flow the site
 * itself won't allow right now. */
const sectionWithAdd = (
  href: string,
  label: string,
  addHref: string,
  addLabel: string,
): NavItem[] =>
  isReadOnly()
    ? [{ href, label }]
    : [
        { href, label },
        { href: addHref, label: addLabel },
      ];

const listingsNavItems = (): NavItem[] =>
  sectionWithAdd(
    "/admin/listings",
    t("terms.listings"),
    "/admin/listing/new",
    t("listings_table.add_listing"),
  );

const groupsNavItems = (): NavItem[] =>
  sectionWithAdd(
    "/admin/groups",
    t("terms.groups"),
    "/admin/groups/new",
    t("groups.add_group"),
  );

/** Editors only ever reach the content pages: listings, groups, and the public
 * site editor. Everything else is gated away, so their nav lists exactly those
 * (no dead/forbidden links). The Site editor is surfaced top-level here because
 * the owner-only Settings parent it normally nests under is hidden from them. */
const editorTopLevelItems = (): NavItem[] => [
  ...listingsNavItems(),
  ...groupsNavItems(),
  { href: "/admin/site", label: t("nav.site") },
];

/** Top-level admin links, in order. Users and Settings are owner-only. `active`
 * is the highlighted section route — passed so the Site parent stays present
 * while an owner is on the Site editor even before the public site is enabled
 * (otherwise the desktop sub-nav, which nests under the matching top item, would
 * have no parent to hang from). */
const topLevelItems = (session: AdminSession, active: string): NavItem[] =>
  session.adminLevel === "editor"
    ? editorTopLevelItems()
    : compact([
        { href: "/admin/", label: t("nav.public.home") },
        ...listingsNavItems(),
        { href: "/admin/calendar", label: t("nav.calendar") },
        ...sectionWithAdd(
          "/admin/servicing",
          t("nav.servicing"),
          "/admin/servicing/new",
          t("nav.servicing_add"),
        ),
        ...sectionWithAdd(
          "/admin/attendees",
          t("terms.attendees"),
          "/admin/attendees/new",
          t("admin.listings.add_attendee"),
        ),
        ...(session.adminLevel === "owner"
          ? sectionWithAdd(
              "/admin/users",
              t("terms.users"),
              "/admin/user/new",
              t("users.invite_user"),
            )
          : []),
        ...groupsNavItems(),
        ...sectionWithAdd(
          "/admin/modifiers",
          t("terms.modifiers"),
          "/admin/modifiers/new",
          t("modifiers.add_modifier"),
        ),
        session.adminLevel === "owner"
          ? { href: "/admin/ledger", label: t("nav.ledger") }
          : null,
        // Site is a top-level section for owners once the public site is on —
        // or whenever they're on the Site editor itself, so the section keeps a
        // desktop parent even before enabling the public site. (Editors always
        // have it top-level; managers/agents never edit the site.)
        session.adminLevel === "owner" &&
        (settings.showPublicSite || active === "/admin/site")
          ? { href: "/admin/site", label: t("nav.site") }
          : null,
        session.adminLevel === "owner"
          ? { href: "/admin/settings", label: t("nav.settings") }
          : null,
      ]);

/** Calendar sub-nav: shown only when logistics adds the deliveries run sheet to
 * branch to — otherwise the section is just the calendar, with no sub-nav. */
const calendarSub = (): NavItem[] | null =>
  settings.hasLogistics
    ? [
        { href: "/admin/calendar", label: t("nav.calendar") },
        { href: "/admin/deliveries", label: t("nav.deliveries") },
      ]
    : null;

/** Users sub-nav. */
const usersSub = (): NavItem[] => [
  { href: "/admin/users", label: t("terms.users") },
  { href: "/admin/sessions", label: t("nav.sub.sessions") },
  { href: "/admin/api-keys", label: t("nav.sub.api_keys") },
];

/** Settings sub-nav. Built sites and Support appear only when enabled. (Site is
 * no longer here — it's a top-level section; see `resolveSection`.) */
const settingsSub = (): NavItem[] =>
  compact([
    { href: "/admin/settings", label: t("nav.sub.settings") },
    { href: "/admin/listing-defaults", label: t("nav.sub.listing_defaults") },
    { href: "/admin/settings/statuses", label: t("nav.sub.statuses") },
    { href: "/admin/privacy", label: t("nav.sub.privacy") },
    { href: "/admin/questions", label: t("terms.questions") },
    { href: "/admin/logistics", label: t("nav.logistics") },
    { href: "/admin/emails", label: t("nav.emails") },
    { href: "/admin/holidays", label: t("terms.holidays") },
    isBuilderEnabled()
      ? { href: "/admin/built-sites", label: t("nav.built_sites") }
      : null,
    { href: "/admin/settings-advanced", label: t("nav.sub.advanced") },
    { href: "/admin/backup", label: t("nav.sub.backups") },
    { href: "/admin/update", label: t("nav.sub.updates") },
    { href: "/admin/debug", label: t("nav.sub.debug") },
    isSupportEnabled()
      ? { href: "/admin/support", label: t("nav.support") }
      : null,
  ]);

/** Site editor sub-nav (the Site section's own pages). */
const siteSub = (): NavItem[] => [
  { href: "/admin/site", label: t("site.sub_nav.homepage") },
  { href: "/admin/site/contact", label: t("site.sub_nav.contact") },
  { href: "/admin/site/order", label: t("site.sub_nav.order") },
  { href: "/admin/site/pages", label: t("nav.site.pages") },
];

/** Resolve which section (and sub-nav) the active route belongs to. Pages pass
 * their section's route as `active`; site pages pass /admin/site so the Site
 * third level can be added beneath the highlighted Settings link.
 *
 * Editors have no Settings parent, so for them the Site editor's sub-pages hang
 * directly under the top-level Site link — never under the owner-only settings
 * sub-nav (whose siblings they can't open). */
const resolveSection = (
  active: string,
  adminLevel: AdminSession["adminLevel"],
): Section | null => {
  // Site is a top-level section with its own sub-nav for both owner and editor.
  if (active === "/admin/site") {
    return { items: siteSub(), label: t("nav.site"), topHref: "/admin/site" };
  }
  // Editors only ever reach the Site section above; everything below is
  // owner-only (their top-level nav omits these links entirely).
  if (adminLevel === "editor") return null;
  if (active === "/admin/calendar") {
    const items = calendarSub();
    return items
      ? { items, label: t("nav.calendar"), topHref: "/admin/calendar" }
      : null;
  }
  if (active === "/admin/users") {
    return {
      items: usersSub(),
      label: t("terms.users"),
      topHref: "/admin/users",
    };
  }
  if (active === "/admin/settings") {
    return {
      items: settingsSub(),
      label: t("nav.settings"),
      topHref: "/admin/settings",
    };
  }
  return null;
};

/** Lift the plain link schema into leveled-nav nodes: every admin link is live
 * (the schema already omits links the viewer's role can't open), and `active`
 * highlights the current section's top-level link. Sub-navs pass an empty
 * `highlight` since the section route alone can't tell which sub-page is open. */
const toNodes = (items: NavItem[], highlight: string): LeveledNavNode[] =>
  items.map((item) => ({
    ...item,
    active: item.href === highlight,
    live: true,
  }));

/** The section's sub-nav as the model's submenu levels — one level, or none. */
const sectionLevels = (section: Section | null): LeveledNavLevel[] =>
  section ? [{ label: section.label, nodes: toNodes(section.items, "") }] : [];

interface AdminNavProps {
  active: string;
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
  const section = resolveSection(active, session.adminLevel);
  const highlight = section?.topHref ?? active;
  const rootNodes = toNodes(topLevelItems(session, active), highlight);
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
        levels: sectionLevels(section),
        rootLis: (nested) => nodeLis(rootNodes, nested),
      })}
    </>
  );
};
