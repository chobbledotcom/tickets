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
import { isStorageEnabled } from "#shared/storage.ts";
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

const navItem = (href: string, label: string): NavItem => ({ href, label });
const imagesItem = (): NavItem => navItem("/admin/images", t("terms.images"));
const siteItem = (): NavItem => navItem("/admin/site", t("nav.site"));

/** True when `active` is any route in the Site section — the editor landing
 * (/admin/site) or a sub-page (/admin/site/contact, /admin/site/pages, …). Used
 * to keep the top-level Site parent present for an owner editing the site before
 * it's public: the desktop sub-nav nests under the active parent, so without the
 * parent the Contact/Order/Pages links would have nothing to hang from. */
const isSiteSectionRoute = (active: string): boolean =>
  active === "/admin/site" || active.startsWith("/admin/site/");

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

/** Editors only ever reach the content pages: listings, groups, and the public
 * site editor. Everything else is gated away, so their nav lists exactly those
 * (no dead/forbidden links). The Site editor is surfaced top-level here because
 * the owner-only Settings parent it normally nests under is hidden from them. */
const editorTopLevelItems = (): NavItem[] =>
  compact([
    navItem("/admin/listings", t("terms.listings")),
    navItem("/admin/groups", t("terms.groups")),
    isStorageEnabled() ? imagesItem() : null,
    siteItem(),
  ]);

/** Top-level admin links, in order. Users and Settings are owner-only. Each
 * link is only the section's landing page — the "Add X" create links live in
 * that section's sub-nav (see the section builders below), so they show only
 * once you're inside the section, not on every page. `active` is passed so the
 * Site parent stays present while an owner is on the Site editor even before
 * the public site is enabled (otherwise the desktop sub-nav, which nests under
 * the matching top item, would have no parent to hang from). */
const topLevelItems = (session: AdminSession, active: string): NavItem[] =>
  session.adminLevel === "editor"
    ? editorTopLevelItems()
    : compact([
        { href: "/admin/", label: t("nav.public.home") },
        navItem("/admin/listings", t("terms.listings")),
        { href: "/admin/calendar", label: t("nav.calendar") },
        { href: "/admin/servicing", label: t("nav.servicing") },
        { href: "/admin/attendees", label: t("terms.attendees") },
        session.adminLevel === "owner"
          ? { href: "/admin/users", label: t("terms.users") }
          : null,
        navItem("/admin/groups", t("terms.groups")),
        isStorageEnabled() ? imagesItem() : null,
        { href: "/admin/modifiers", label: t("terms.modifiers") },
        session.adminLevel === "owner"
          ? { href: "/admin/ledger", label: t("nav.ledger") }
          : null,
        // Site is a top-level section for owners once the public site is on —
        // or whenever they're on any Site editor page, so the section keeps a
        // desktop parent even before enabling the public site. (Editors always
        // have it top-level; managers/agents never edit the site.)
        session.adminLevel === "owner" &&
        (settings.showPublicSite || isSiteSectionRoute(active))
          ? siteItem()
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

/** A section's landing link paired with its "Add X" sibling — the repeated
 * two-item shape every section with its own create page uses (Listings, Groups,
 * Attendees, Modifiers, Servicing, Users). The "Add X" sibling lives in the
 * section's sub-nav, so it only shows once you're inside that section, and it
 * drops out in read-only mode, matching every other create affordance's own
 * page (the dashboard's Add Listing button, the Modifiers page's Add Modifier
 * button, …) — a nav link must not offer a create flow the site itself won't
 * allow right now. */
const sectionWithAdd = (
  href: string,
  label: string,
  addHref: string,
  addLabel: string,
): NavItem[] => [
  { href, label },
  ...(isReadOnly() ? [] : [{ href: addHref, label: addLabel }]),
];

/** Listings sub-nav: the listings table plus its create link. */
const listingsSub = (): NavItem[] =>
  sectionWithAdd(
    "/admin/listings",
    t("terms.listings"),
    "/admin/listing/new",
    t("listings_table.add_listing"),
  );

/** Groups sub-nav: the groups table plus its create link. */
const groupsSub = (): NavItem[] =>
  sectionWithAdd(
    "/admin/groups",
    t("terms.groups"),
    "/admin/groups/new",
    t("groups.add_group"),
  );

/** Servicing sub-nav: the servicing list plus its create link. */
const servicingSub = (): NavItem[] =>
  sectionWithAdd(
    "/admin/servicing",
    t("nav.servicing"),
    "/admin/servicing/new",
    t("nav.servicing_add"),
  );

/** Attendees sub-nav: the attendees browser plus its create link. */
const attendeesSub = (): NavItem[] =>
  sectionWithAdd(
    "/admin/attendees",
    t("terms.attendees"),
    "/admin/attendees/new",
    t("admin.listings.add_attendee"),
  );

/** Modifiers sub-nav: the modifiers list plus its create link. */
const modifiersSub = (): NavItem[] =>
  sectionWithAdd(
    "/admin/modifiers",
    t("terms.modifiers"),
    "/admin/modifiers/new",
    t("modifiers.add_modifier"),
  );

/** Users sub-nav: the users list and its Invite link, then sessions/API keys. */
const usersSub = (): NavItem[] => [
  ...sectionWithAdd(
    "/admin/users",
    t("terms.users"),
    "/admin/user/new",
    t("users.invite_user"),
  ),
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

const section = (
  topHref: string,
  label: string,
  items: NavItem[],
): Section => ({
  items,
  label,
  topHref,
});

/** Every section that owns a sub-nav, for this role. A section only appears for
 * a role that can see its top-level link, so we never resolve a sub-nav whose
 * parent link the viewer doesn't have. Calendar drops out when it has no
 * deliveries run sheet to branch to (just the calendar, no sub-nav).
 *
 * Editors only ever reach the content sections (Listings, Groups) and the Site
 * editor; everything else is owner-only, so their list omits it entirely. */
const sectionsForRole = (adminLevel: AdminSession["adminLevel"]): Section[] => {
  const siteSection = section("/admin/site", t("nav.site"), siteSub());
  if (adminLevel === "editor") {
    return [
      section("/admin/listings", t("terms.listings"), listingsSub()),
      section("/admin/groups", t("terms.groups"), groupsSub()),
      siteSection,
    ];
  }
  const calendar = calendarSub();
  return compact([
    section("/admin/listings", t("terms.listings"), listingsSub()),
    calendar ? section("/admin/calendar", t("nav.calendar"), calendar) : null,
    section("/admin/servicing", t("nav.servicing"), servicingSub()),
    section("/admin/attendees", t("terms.attendees"), attendeesSub()),
    section("/admin/modifiers", t("terms.modifiers"), modifiersSub()),
    section("/admin/groups", t("terms.groups"), groupsSub()),
    adminLevel === "owner"
      ? section("/admin/users", t("terms.users"), usersSub())
      : null,
    adminLevel === "owner"
      ? section("/admin/settings", t("nav.settings"), settingsSub())
      : null,
    adminLevel === "owner" ? siteSection : null,
  ]);
};

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
  adminLevel: AdminSession["adminLevel"],
): Section | null =>
  sectionsForRole(adminLevel).find((candidate) =>
    ownsActive(candidate, active),
  ) ?? null;

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
  return [
    {
      label: sectionItems.label,
      nodes: toNodes(sectionItems.items, subHighlight),
    },
  ];
};

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
  const activeSection = resolveSection(active, session.adminLevel);
  const highlight = activeSection?.topHref ?? active;
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
        levels: sectionLevels(activeSection, active),
        rootLis: (nested) => nodeLis(rootNodes, nested),
      })}
    </>
  );
};
