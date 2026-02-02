/**
 * Shared admin navigation component
 */

import type { AdminLevel } from "#lib/types.ts";

interface AdminNavProps {
  adminLevel?: AdminLevel;
}

/**
 * Main admin navigation - shown at top of all admin pages
 * Users, Settings, and Sessions links only shown to owners
 */
export const AdminNav = ({ adminLevel }: AdminNavProps = {}): JSX.Element => (
  <nav>
    <ul>
      <li><a href="/admin/">Events</a></li>
      {adminLevel === "owner" && <li><a href="/admin/users">Users</a></li>}
      {adminLevel === "owner" && <li><a href="/admin/settings">Settings</a></li>}
      {adminLevel === "owner" && <li><a href="/admin/log">Log</a></li>}
      {adminLevel === "owner" && <li><a href="/admin/sessions">Sessions</a></li>}
      <li><a href="/admin/logout">Logout</a></li>
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
  <p><a href={href}>&larr; {label}</a></p>
);
