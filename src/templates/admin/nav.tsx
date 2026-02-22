/**
 * Shared admin navigation component
 */

import { CsrfForm } from "#lib/forms.tsx";
import type { AdminSession } from "#lib/types.ts";

interface AdminNavProps {
  session: AdminSession;
}

/**
 * Universal admin navigation - shown at top of all admin pages
 * Users, Settings, and Sessions links only shown to owners
 */
export const AdminNav = ({ session }: AdminNavProps): JSX.Element => (
  <nav>
    <ul>
      <li><a href="/admin/">Events</a></li>
      <li><a href="/admin/calendar">Calendar</a></li>
      {session.adminLevel === "owner" && <li><a href="/admin/users">Users</a></li>}
      {session.adminLevel === "owner" && <li><a href="/admin/settings">Settings</a></li>}
      {session.adminLevel === "owner" && <li><a href="/admin/log">Log</a></li>}
      {session.adminLevel === "owner" && <li><a href="/admin/groups">Groups</a></li>}
      {session.adminLevel === "owner" && <li><a href="/admin/holidays">Holidays</a></li>}
      {session.adminLevel === "owner" && <li><a href="/admin/sessions">Sessions</a></li>}
      <li><a href="/admin/guide">Guide</a></li>
      <li>
        <CsrfForm action="/admin/logout" class="inline">
          <button type="submit">Logout</button>
        </CsrfForm>
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
  <p><a href={href}>&larr; {label}</a></p>
);
