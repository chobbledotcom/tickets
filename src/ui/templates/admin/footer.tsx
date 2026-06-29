/**
 * Admin footer.
 *
 * Rendered at the bottom of every admin page: a top row with the Chobble
 * Tickets link (growing to fill the space) on the left and inline utility links
 * on the right, all always on one line; and, when query
 * logging is active, a debug menu (render time, SQL queries, cache stats) on a
 * row below them.
 *
 * The footer only renders on admin pages — `markAdminFooter()` is called while
 * the page's nav/header renders, and `renderAdminFooter()` (called once from
 * the Layout) consumes and resets that flag so it never leaks onto a later
 * public-page render in the same isolate.
 */

import { compact, reduce } from "#fp";
import { t } from "#i18n";
import { type CacheStat, getAllCacheStats } from "#shared/cache-registry.ts";
import {
  getQueryLog,
  getQueryLogStartTime,
  isFooterDebugEnabled,
  type QueryLogEntry,
  sqlWallClockMs,
} from "#shared/db/query-log.ts";
import { type AdminLevel, isStaffRole } from "#shared/types.ts";
import { getUptimeSeconds } from "#shared/uptime.ts";

/** Data passed to the debug-details renderer */
export type DebugFooterData = {
  readonly renderTimeMs: number;
  readonly queries: QueryLogEntry[];
  readonly cacheStats: CacheStat[];
  readonly uptimeSeconds: number;
};

/** Set while an admin page renders so its footer is emitted by the Layout. Holds
 * the viewer's role so the footer's utility links can be gated (e.g. the
 * activity log is staff-only; the guide is hidden from delivery agents). */
const _adminFooterStore = { adminLevel: null as AdminLevel | null };

/** Flag the current render as an admin page so its footer (with logout) shows,
 * recording the viewer's role for the footer's role-aware links. */
export const markAdminFooter = (adminLevel: AdminLevel): void => {
  _adminFooterStore.adminLevel = adminLevel;
};

/** Total query work: the sum of every query's duration, counting concurrent
 * and batched queries in full. Pairs with the wall-clock figure to expose how
 * much of that work overlapped (the parallel factor). */
const sumDurations = reduce(
  (total: number, q: QueryLogEntry) => total + q.durationMs,
  0,
);

/** Render a single cache stat line */
const renderCacheStat = (stat: CacheStat): string =>
  stat.capacity
    ? `<li>${escapeFooterHtml(
        stat.name,
      )}: ${stat.entries}/${stat.capacity}</li>`
    : `<li>${escapeFooterHtml(stat.name)}: ${stat.entries}</li>`;

/** The debug menu: a collapsible details/summary with render time, SQL queries
 * and cache stats. Shown in the footer only when query logging is active. */
export const debugDetailsHtml = (data: DebugFooterData): string => {
  const { renderTimeMs, queries, cacheStats, uptimeSeconds } = data;
  // Wall-clock time blocked on SQL (overlaps merged) vs. total query work
  // (durations summed). They diverge exactly when queries ran concurrently or
  // were batched, so `render = sqlWall + other` is a true, non-negative split
  // and `work / sqlWall` is the parallel factor.
  const sqlWallMs = sqlWallClockMs(queries);
  const sqlWorkMs = sumDurations(queries);
  const otherMs = renderTimeMs - sqlWallMs;
  const parallelFactor = sqlWallMs > 0 ? sqlWorkMs / sqlWallMs : 1;
  const totalCacheEntries = reduce(
    (total: number, s: CacheStat) => total + s.entries,
    0,
  )(cacheStats);

  return (
    `<details class="debug-menu">` +
    `<summary>${renderTimeMs.toFixed(0)}ms` +
    ` &middot; ${queries.length} quer${queries.length === 1 ? "y" : "ies"} ${sqlWallMs.toFixed(
      0,
    )}ms` +
    ` &middot; ${totalCacheEntries} cached` +
    ` &middot; up ${uptimeSeconds.toFixed(0)}s</summary>` +
    `<p>Render: ${renderTimeMs.toFixed(1)}ms` +
    ` (sql ${sqlWallMs.toFixed(1)}ms + other ${otherMs.toFixed(1)}ms)</p>` +
    (queries.length > 0
      ? `<p>SQL: ${sqlWorkMs.toFixed(1)}ms work across ${queries.length} quer${
          queries.length === 1 ? "y" : "ies"
        }, ${parallelFactor.toFixed(1)}&times; parallel</p>`
      : "") +
    (queries.length > 0
      ? `<details><summary>${t("admin.footer.sql_queries")}</summary><ul>` +
        queries
          .map(
            (q) =>
              `<li>${escapeFooterHtml(q.sql)} &mdash; ${q.durationMs.toFixed(
                1,
              )}ms</li>`,
          )
          .join("") +
        "</ul></details>"
      : "") +
    (cacheStats.length > 0
      ? `<details><summary>${t(
          "admin.footer.caches",
        )} (${cacheStats.length})</summary><ul>` +
        cacheStats.map(renderCacheStat).join("") +
        "</ul></details>"
      : "") +
    "</details>"
  );
};

/** The footer's right-hand utility links, gated by role so none is a dead link:
 * the activity log and the guide are staff-only (the guide body links to many
 * owner/staff pages), and logout is for everyone. */
const footerLinks = (adminLevel: AdminLevel): string =>
  compact([
    isStaffRole(adminLevel) ? `<a href="/admin/log">${t("nav.log")}</a>` : null,
    isStaffRole(adminLevel)
      ? `<a href="/admin/guide">${t("nav.guide")}</a>`
      : null,
    `<a href="/admin/logout">${t("nav.logout")}</a>`,
  ]).join(" &middot; ");

/** Build the admin footer: Chobble link (plus the debug menu when present) on
 * the left, role-gated utility links on the right. */
export const adminFooterHtml = (
  debug: DebugFooterData | null,
  adminLevel: AdminLevel,
): string =>
  `<footer class="admin-footer">` +
  `<div class="admin-footer-top">` +
  `<a href="https://github.com/chobbledotcom/tickets">${t(
    "admin.footer.chobble_tickets",
  )}</a>` +
  `<div class="admin-footer-links">${footerLinks(adminLevel)}</div>` +
  "</div>" +
  (debug
    ? `<div class="admin-footer-info">${debugDetailsHtml(debug)}</div>`
    : "") +
  "</footer>";

/**
 * Return the admin footer HTML when the current render is an admin page,
 * otherwise "". Called once from the Layout so the footer is part of the HTML
 * string before it is wrapped in a Response (avoiding response.text() on Bunny
 * Edge). Consumes and resets the admin-page flag.
 */
export const renderAdminFooter = (): string => {
  const adminLevel = _adminFooterStore.adminLevel;
  _adminFooterStore.adminLevel = null;
  if (!adminLevel) return "";
  const debug = isFooterDebugEnabled()
    ? {
        cacheStats: getAllCacheStats(),
        queries: getQueryLog(),
        renderTimeMs: performance.now() - getQueryLogStartTime(),
        uptimeSeconds: getUptimeSeconds(),
      }
    : null;
  return adminFooterHtml(debug, adminLevel);
};

/** Minimal HTML escaping for strings in the footer */
const escapeFooterHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
