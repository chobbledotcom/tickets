/**
 * Shared admin navigation component
 */

/**
 * Main admin navigation - shown at top of all admin pages
 */
export const AdminNav = (): JSX.Element => (
  <nav>
    <ul>
      <li><a href="/admin/">Dashboard</a></li>
      <li><a href="/admin/settings">Settings</a></li>
      <li><a href="/admin/sessions">Sessions</a></li>
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
