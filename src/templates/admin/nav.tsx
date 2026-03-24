/**
 * Shared admin navigation component
 */

import { settings } from "#lib/db/settings.ts";
import { CsrfForm } from "#lib/forms.tsx";
import type { AdminSession } from "#lib/types.ts";

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
      {navLink("/admin/guide", "Guide", active)}
      <li>
        <CsrfForm action="/admin/logout" class="inline">
          <button type="submit">Logout</button>
        </CsrfForm>
      </li>
    </ul>
  </nav>
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

interface BreadcrumbProps {
  href: string;
  label: string;
}

/**
 * Breadcrumb link for sub-pages
 */
export const Breadcrumb = ({ href, label }: BreadcrumbProps): JSX.Element => (
  <p>
    <a href={href}>&larr; {label}</a>
  </p>
);
