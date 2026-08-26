/**
 * Admin footer.
 *
 * `markAdminFooter()` runs while the page's nav renders, and the Layout's one
 * `renderAdminFooter()` call consumes and resets that flag. Without the reset
 * the footer leaks onto a later public-page render in the same isolate.
 *
 * The Chobble Tickets link sits in a span that grows to fill the row, so the
 * link itself stays only as wide as its text.
 */

import {
  getQueryLog,
  getQueryLogStartTime,
  isFooterDebugEnabled,
  type QueryLogEntry,
  sqlWallClockMs,
} from "#db/query-log.ts";
import { compact, reduce } from "#fp";
import { t } from "#i18n";
import { type CacheStat, getAllCacheStats } from "#shared/cache-registry.ts";
import { createRequestScoped } from "#shared/request-scoped.ts";
import { getUptimeSeconds } from "#shared/uptime.ts";
import { type AdminLevel, isStaffRole } from "#types";

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
const adminFooterScope = createRequestScoped(() => ({
  adminLevel: null as AdminLevel | null,
}));

/** Run one request with an isolated admin footer marker. */
export const runWithAdminFooterContext = <T,>(fn: () => T): T =>
  adminFooterScope.run(fn);

/** Flag the current render as an admin page so its footer (with logout) shows,
 * recording the viewer's role for the footer's role-aware links. */
export const markAdminFooter = (adminLevel: AdminLevel): void => {
  adminFooterScope.current().adminLevel = adminLevel;
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
  `<span class="admin-footer-brand"><a href="https://github.com/chobbledotcom/tickets">${t(
    "admin.footer.chobble_tickets",
  )}</a></span>` +
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
  const store = adminFooterScope.current();
  const adminLevel = store.adminLevel;
  store.adminLevel = null;
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
