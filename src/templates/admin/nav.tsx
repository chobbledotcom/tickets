/**
 * Shared admin navigation component
 */

import { settings } from "#lib/db/settings.ts";
import { isReadOnly } from "#lib/env.ts";
import { CsrfForm } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { AdminSession } from "#lib/types.ts";
import { isBuilderEnabled } from "#routes/admin/builder.ts";

/** Read-only mode banner HTML */
export const READ_ONLY_BANNER =
  '<div class="read-only-banner">This site is in read-only mode</div>';

interface AdminNavProps {
  session: AdminSession;
  active: string;
}

const navLink = (href: string, label: string, active: string): JSX.Element => (
  <li>
    <a href={href} class={href === active ? "active" : undefined}>
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
    {isReadOnly() && <Raw html={READ_ONLY_BANNER} />}
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
        <a href="/admin/debug">Debug</a>
      </li>
    </ul>
  </nav>
);
