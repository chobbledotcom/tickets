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
import { CsrfForm } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { isSupportEnabled } from "#shared/support.ts";
import type { AdminSession } from "#shared/types.ts";
import { SettingsNagBanner } from "#templates/admin/settings-nag-banner.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";

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
export const AdminNav = ({ session, active }: AdminNavProps): JSX.Element => (
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
    <nav id="main-nav">
      <ul>
        {navLink("/admin/", t("nav.listings"), active)}
        {navLink("/admin/calendar", t("nav.calendar"), active)}
        {navLink("/admin/attendees", t("nav.attendees"), active)}
        {session.adminLevel === "owner" &&
          navLink("/admin/users", t("nav.users"), active)}
        {session.adminLevel === "owner" &&
          settings.showPublicSite &&
          navLink("/admin/site", t("nav.site"), active)}
        {session.adminLevel === "owner" &&
          navLink("/admin/emails", t("nav.emails"), active)}
        {session.adminLevel === "owner" &&
          navLink("/admin/settings", t("nav.settings"), active)}
        {navLink("/admin/log", t("nav.log"), active)}
        {navLink("/admin/groups", t("nav.groups"), active)}
        {session.adminLevel === "owner" &&
          navLink("/admin/holidays", t("nav.holidays"), active)}
        {session.adminLevel === "owner" &&
          isBuilderEnabled() &&
          navLink("/admin/built-sites", t("nav.built_sites"), active)}
        {navLink("/admin/guide", t("nav.guide"), active)}
        {session.adminLevel === "owner" &&
          isSupportEnabled() &&
          navLink("/admin/support", t("nav.support"), active)}
        <li>
          <CsrfForm action="/admin/logout" class="inline">
            <SubmitButton icon="log-out">{t("nav.logout")}</SubmitButton>
          </CsrfForm>
        </li>
      </ul>
    </nav>
  </>
);

/** Sub-navigation for user-related pages */
export const UsersSubNav = (): JSX.Element => (
  <nav>
    <ul>
      <li>
        <a href="/admin/users">{t("nav.sub.users")}</a>
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
    </ul>
  </nav>
);
