/**
 * Shared admin navigation component
 */

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
import type { AdminSession } from "#shared/types.ts";
import { SettingsNagBanner } from "#templates/admin/settings-nag-banner.tsx";

/** Render read-only or warning banner with optional renewal URL */
const renderReadOnlyBanner = (
  readOnly: boolean,
  warning: boolean,
  cutoffIso: string | null,
  renewalUrl: string | null,
): JSX.Element | null => {
  if (readOnly) {
    const link = renewalUrl ? ` — <a href="${renewalUrl}">Renew now</a>` : "";
    return (
      <Raw
        html={`<div class="read-only-banner">This site is in read-only mode${link}</div>`}
      />
    );
  }
  if (warning) {
    const link = renewalUrl ? ` — <a href="${renewalUrl}">Renew now</a>` : "";
    const dateStr = new Date(String(cutoffIso)).toLocaleDateString();
    const msg = dateStr
      ? `Your site expires on ${dateStr}${link}`
      : `Your site is approaching its expiry${link}`;
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
    {session.adminLevel === "owner" && <SettingsNagBanner />}
    <nav id="main-nav">
      <ul>
        {navLink("/admin/", "Events", active)}
        {navLink("/admin/calendar", "Calendar", active)}
        {session.adminLevel === "owner" &&
          navLink("/admin/users", "Users", active)}
        {session.adminLevel === "owner" &&
          settings.showPublicSite &&
          navLink("/admin/site", "Site", active)}
        {session.adminLevel === "owner" &&
          navLink("/admin/settings", "Settings", active)}
        {navLink("/admin/log", "Log", active)}
        {navLink("/admin/groups", "Groups", active)}
        {session.adminLevel === "owner" &&
          navLink("/admin/holidays", "Holidays", active)}
        {session.adminLevel === "owner" &&
          isBuilderEnabled() &&
          navLink("/admin/built-sites", "Built Sites", active)}
        {navLink("/admin/guide", "Guide", active)}
        <li>
          <CsrfForm action="/admin/logout" class="inline">
            <button type="submit">Logout</button>
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
        <a href="/admin/users">Users</a>
      </li>
      <li>
        <a href="/admin/sessions">Sessions</a>
      </li>
      <li>
        <a href="/admin/api-keys">API Keys</a>
      </li>
    </ul>
  </nav>
);

/** Sub-navigation for settings-related pages */
export const SettingsSubNav = (): JSX.Element => (
  <nav>
    <ul>
      <li>
        <a href="/admin/settings">Settings</a>
      </li>
      <li>
        <a href="/admin/settings-advanced">Advanced</a>
      </li>
      <li>
        <a href="/admin/backup">Backups</a>
      </li>
      <li>
        <a href="/admin/update">Updates</a>
      </li>
      <li>
        <a href="/admin/debug">Debug</a>
      </li>
    </ul>
  </nav>
);
