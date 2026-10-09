/**
 * Which surface a page belongs to, as site-wide Custom CSS sees it. The page
 * `Layout` renders the value as `body[data-page-family]` on every page, so
 * one Custom CSS rule can target one surface:
 *
 * - `admin`: the staff backend, including the admin login and staff tools.
 * - `public`: the pages a visitor opens in normal operation.
 * - `system`: setup, account activation, and the request pipeline's own
 *   pages. These are the pages it serves when no real page can load:
 *   not found, temporary error, database busy, migration in progress, and
 *   site not activated.
 */

export type PageFamily = "admin" | "public" | "system";
