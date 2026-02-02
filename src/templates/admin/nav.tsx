/**
 * Shared admin navigation component
 */

import type { AdminSession } from "#lib/types.ts";

interface AdminNavProps {
  session?: AdminSession;
}

/**
 * Universal admin navigation - shown at top of all admin pages
 * Users, Settings, and Sessions links only shown to owners
 */
export const AdminNav = ({ session }: AdminNavProps = {}): JSX.Element => (
  <nav>
    <ul>
      <li><a href="/admin/">Events</a></li>
      {session?.adminLevel === "owner" && <li><a href="/admin/users">Users</a></li>}
      {session?.adminLevel === "owner" && <li><a href="/admin/settings">Settings</a></li>}
      {session?.adminLevel === "owner" && <li><a href="/admin/log">Log</a></li>}
      {session?.adminLevel === "owner" && <li><a href="/admin/sessions">Sessions</a></li>}
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
