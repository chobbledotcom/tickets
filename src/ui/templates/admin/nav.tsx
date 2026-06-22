/**
 * Shared admin navigation component
 */

import { t } from "#i18n";
import { isBuilderEnabled } from "#routes/admin/builder.ts";
import { settings } from "#shared/db/settings.ts";
import {
  getReadOnlyCutoffIso,
  getRenewalUrl,
  isReadOnly,
  isReadOnlyWarning,
} from "#shared/env.ts";
import { type Child, Raw } from "#shared/jsx/jsx-runtime.ts";
import { isSupportEnabled } from "#shared/support.ts";
import type { AdminSession } from "#shared/types.ts";
import { markAdminFooter } from "#templates/admin/footer.tsx";
import { SettingsNagBanner } from "#templates/admin/settings-nag-banner.tsx";

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

interface AdminNavProps {
  active: string;
  session: AdminSession;
  /** Optional sub-navigation for the current section. Rendered inside the same
   * `.admin-nav-group` wrapper as the main nav so that, on desktop, the two
   * read as one merged sidebar menu (the sub-nav indented). On mobile/tablet
   * the wrapper is `display: contents`, so the navs lay out unchanged. */
  children?: Child;
}

const navLink = (href: string, label: string, active: string): JSX.Element => (
  <li>
    <a class={href === active ? "active" : undefined} href={href}>
      {label}
    </a>
  </li>
);

/**
 * Universal admin navigation - shown at top of all admin pages
 * Users, Settings, and Sessions links only shown to owners
 */
export const AdminNav = ({
  session,
  active,
  children,
}: AdminNavProps): JSX.Element => {
  // Flag this render as an admin page so the Layout emits the admin footer
  // (Chobble link, optional debug menu, and the logout button).
  markAdminFooter();
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
      {/* Main nav + the current section's sub-nav share one wrapper so desktop
          CSS can pin them together as a single sticky left-hand menu. */}
      <div class="admin-nav-group">
        <nav id="main-nav">
          <ul>
            {navLink("/admin/", t("nav.public.home"), active)}
            {navLink("/admin/listings", t("terms.listings"), active)}
            {navLink("/admin/calendar", t("nav.calendar"), active)}
            {navLink("/admin/attendees", t("terms.attendees"), active)}
            {session.adminLevel === "owner" &&
              navLink("/admin/users", t("terms.users"), active)}
            {navLink("/admin/groups", t("terms.groups"), active)}
            {navLink("/admin/modifiers", t("terms.modifiers"), active)}
            {session.adminLevel === "owner" &&
              navLink("/admin/settings", t("nav.settings"), active)}
          </ul>
        </nav>
        {children}
      </div>
    </>
  );
};

/** Sub-navigation under Calendar: the calendar itself plus, when logistics is
 * enabled, the deliveries run sheet — so staff can reach it from the menu.
 * Returns null when logistics is off (nothing to branch to). */
export const CalendarSubNav = (): JSX.Element | null =>
  settings.hasLogistics ? (
    <nav>
      <ul>
        <li>
          <a href="/admin/calendar">{t("nav.calendar")}</a>
        </li>
        <li>
          <a href="/admin/deliveries">{t("nav.deliveries")}</a>
        </li>
      </ul>
    </nav>
  ) : null;

/** Sub-navigation for user-related pages */
export const UsersSubNav = (): JSX.Element => (
  <nav>
    <ul>
      <li>
        <a href="/admin/users">{t("terms.users")}</a>
      </li>
      <li>
        <a href="/admin/sessions">{t("nav.sub.sessions")}</a>
      </li>
      <li>
        <a href="/admin/api-keys">{t("nav.sub.api_keys")}</a>
      </li>
    </ul>
  </nav>
);

/** Sub-navigation for settings-related pages */
export const SettingsSubNav = (): JSX.Element => (
  <nav>
    <ul>
      <li>
        <a href="/admin/settings">{t("nav.sub.settings")}</a>
      </li>
      <li>
        <a href="/admin/settings/statuses">{t("nav.sub.statuses")}</a>
      </li>
      <li>
        <a href="/admin/privacy">{t("nav.sub.privacy")}</a>
      </li>
      <li>
        <a href="/admin/questions">{t("terms.questions")}</a>
      </li>
      <li>
        <a href="/admin/logistics">{t("nav.logistics")}</a>
      </li>
      <li>
        <a href="/admin/emails">{t("nav.emails")}</a>
      </li>
      {settings.showPublicSite && (
        <li>
          <a href="/admin/site">{t("nav.site")}</a>
        </li>
      )}
      <li>
        <a href="/admin/holidays">{t("terms.holidays")}</a>
      </li>
      {isBuilderEnabled() && (
        <li>
          <a href="/admin/built-sites">{t("nav.built_sites")}</a>
        </li>
      )}
      <li>
        <a href="/admin/settings-advanced">{t("nav.sub.advanced")}</a>
      </li>
      <li>
        <a href="/admin/backup">{t("nav.sub.backups")}</a>
      </li>
      <li>
        <a href="/admin/update">{t("nav.sub.updates")}</a>
      </li>
      <li>
        <a href="/admin/debug">{t("nav.sub.debug")}</a>
      </li>
      {isSupportEnabled() && (
        <li>
          <a href="/admin/support">{t("nav.support")}</a>
        </li>
      )}
    </ul>
  </nav>
);
