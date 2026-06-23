/**
 * Shared admin navigation.
 *
 * AdminNav builds the whole menu for the current page from one schema: the
 * top-level links, plus — for the section the page belongs to — that section's
 * sub-nav. It emits two structures and lets CSS show whichever fits:
 *
 *  - a desktop sidebar, where the sub-nav is nested inside its parent <li> (and
 *    the site editor's third level nested again), and
 *  - mobile bars, where the sub-nav follows the top-level row as its own bar.
 *
 * Each layout keeps its own correctly-ordered DOM, so tab/reading order always
 * matches what's shown — no CSS `order` reshuffling, and the two can diverge
 * freely in future.
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

/** One navigation link. */
interface NavItem {
  href: string;
  label: string;
}

/** A third navigation level nested beneath one sub-nav item (the site editor's
 * pages, under Settings → Site). */
interface NestedSub {
  /** href of the sub-item these items hang beneath (e.g. /admin/site). */
  under: string;
  /** Accessible name for this level's mobile nav landmark. */
  label: string;
  items: NavItem[];
}

/** The resolved menu for the active section: which top-level link to highlight,
 * an accessible name for its sub-nav, its items, and an optional third level. */
interface Section {
  /** Top-level link highlighted for this section (the page may live deeper). */
  topHref: string;
  /** Accessible name for this section's sub-nav (mobile) landmark. */
  label: string;
  items: NavItem[];
  nested?: NestedSub;
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

/** Top-level admin links, in order. Users and Settings are owner-only. */
const topLevelItems = (session: AdminSession): NavItem[] =>
  compact([
    { href: "/admin/", label: t("nav.public.home") },
    { href: "/admin/listings", label: t("terms.listings") },
    { href: "/admin/calendar", label: t("nav.calendar") },
    { href: "/admin/attendees", label: t("terms.attendees") },
    session.adminLevel === "owner"
      ? { href: "/admin/users", label: t("terms.users") }
      : null,
    { href: "/admin/groups", label: t("terms.groups") },
    { href: "/admin/modifiers", label: t("terms.modifiers") },
    session.adminLevel === "owner"
      ? { href: "/admin/ledger", label: t("nav.ledger") }
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

/** Settings sub-nav. Built sites and Support appear only when enabled. Site
 * appears when the public site is enabled, or always when `includeSite` is set
 * (the site editor section, which nests its own pages beneath that link). */
const settingsSub = (includeSite = false): NavItem[] =>
  compact([
    { href: "/admin/settings", label: t("nav.sub.settings") },
    { href: "/admin/settings/statuses", label: t("nav.sub.statuses") },
    { href: "/admin/privacy", label: t("nav.sub.privacy") },
    { href: "/admin/questions", label: t("terms.questions") },
    { href: "/admin/logistics", label: t("nav.logistics") },
    { href: "/admin/emails", label: t("nav.emails") },
    includeSite || settings.showPublicSite
      ? { href: "/admin/site", label: t("nav.site") }
      : null,
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

/** Site editor sub-nav (third level, beneath Settings → Site). */
const siteSub = (): NavItem[] => [
  { href: "/admin/site", label: t("site.sub_nav.homepage") },
  { href: "/admin/site/contact", label: t("site.sub_nav.contact") },
  { href: "/admin/site/order", label: t("site.sub_nav.order") },
];

/** Resolve which section (and sub-nav) the active route belongs to. Pages pass
 * their section's route as `active`; site pages pass /admin/site so the Site
 * third level can be added beneath the highlighted Settings link. */
const resolveSection = (active: string): Section | null => {
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
  if (active === "/admin/site") {
    return {
      items: settingsSub(true),
      label: t("nav.settings"),
      nested: { items: siteSub(), label: t("nav.site"), under: "/admin/site" },
      topHref: "/admin/settings",
    };
  }
  return null;
};

/** A single link, highlighted when its href is the active top-level link. */
const navAnchor = (item: NavItem, highlight: string): JSX.Element => (
  <a class={item.href === highlight ? "active" : undefined} href={item.href}>
    {item.label}
  </a>
);

/** Flat <li> list of links. Sub-navs pass an empty `highlight` since the
 * section route alone can't tell which sub-page is open. */
const navItems = (items: NavItem[], highlight: string): JSX.Element[] =>
  items.map((item) => <li>{navAnchor(item, highlight)}</li>);

/** Desktop sidebar: one nav with the sub-nav nested inside its parent <li>, and
 * the site third level nested again — DOM order matches the stacked visual. */
const DesktopNav = ({
  items,
  highlight,
  section,
}: {
  items: NavItem[];
  highlight: string;
  section: Section | null;
}): JSX.Element => (
  <nav
    aria-label={t("nav.admin")}
    class="admin-nav admin-nav--desktop"
    id="main-nav"
  >
    <ul>
      {items.map((item) => (
        <li>
          {navAnchor(item, highlight)}
          {section && item.href === highlight && (
            <ul class="admin-subnav">
              {section.items.map((sub) => (
                <li>
                  {navAnchor(sub, "")}
                  {section.nested && sub.href === section.nested.under && (
                    <ul class="admin-subnav">
                      {navItems(section.nested.items, "")}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  </nav>
);

/** One mobile nav bar (the top-level row, or a sub-nav row beneath it), with an
 * accessible name so screen-reader users can tell the stacked bars apart. */
const mobileBar = (label: string, lis: JSX.Element[]): JSX.Element => (
  <nav aria-label={label} class="admin-nav admin-nav--mobile">
    <ul>{lis}</ul>
  </nav>
);

/** Mobile: the top-level bar, then each sub-nav level as its own bar below —
 * the separate stacked bars admin has always shown on small screens. */
const MobileNav = ({
  items,
  highlight,
  section,
}: {
  items: NavItem[];
  highlight: string;
  section: Section | null;
}): JSX.Element => (
  <>
    {mobileBar(t("nav.admin"), navItems(items, highlight))}
    {section && mobileBar(section.label, navItems(section.items, ""))}
    {section?.nested &&
      mobileBar(section.nested.label, navItems(section.nested.items, ""))}
  </>
);

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
  markAdminFooter();
  const items = topLevelItems(session);
  const section = resolveSection(active);
  const highlight = section?.topHref ?? active;
  return (
    <>
      {renderReadOnlyBanner(
        isReadOnly(),
        isReadOnlyWarning(),
        getReadOnlyCutoffIso(),
        getRenewalUrl(),
      )}
      {session.adminLevel === "owner" && (
        <SettingsNagBanner items={session.settingsNagItems} />
      )}
      {/* The desktop sidebar nav and the mobile bars share one wrapper so the
          desktop grid can pin it as a single sticky left-hand column. */}
      <div class="admin-nav-group">
        <DesktopNav highlight={highlight} items={items} section={section} />
        <MobileNav highlight={highlight} items={items} section={section} />
      </div>
    </>
  );
};
