/**
 * Shared admin navigation component
 */

import { getShowPublicSiteCached } from "#lib/db/settings.ts";
import { CsrfForm } from "#lib/forms.tsx";
import { t } from "#i18n";
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
      {navLink("/admin/", t("nav.events"), active)}
      {navLink("/admin/calendar", t("nav.calendar"), active)}
      {session.adminLevel === "owner" &&
        navLink("/admin/users", t("nav.users"), active)}
      {session.adminLevel === "owner" &&
        getShowPublicSiteCached() &&
        navLink("/admin/site", t("nav.site"), active)}
      {session.adminLevel === "owner" &&
        navLink("/admin/settings", t("nav.settings"), active)}
      {navLink("/admin/log", t("nav.log"), active)}
      {navLink("/admin/groups", t("nav.groups"), active)}
      {session.adminLevel === "owner" &&
        navLink("/admin/holidays", t("nav.holidays"), active)}
      {navLink("/admin/guide", t("nav.guide"), active)}
      <li>
        <CsrfForm action="/admin/logout" class="inline">
          <button type="submit">{t("nav.logout")}</button>
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
