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

import { reduce } from "#fp";
import { t } from "#i18n";
import { type CacheStat, getAllCacheStats } from "#shared/cache-registry.ts";
import {
  getQueryLog,
  getQueryLogStartTime,
  isFooterDebugEnabled,
  type QueryLogEntry,
  sqlWallClockMs,
} from "#shared/db/query-log.ts";
import { getUptimeSeconds } from "#shared/uptime.ts";

/** Data passed to the debug-details renderer */
export type DebugFooterData = {
  readonly renderTimeMs: number;
  readonly queries: QueryLogEntry[];
  readonly cacheStats: CacheStat[];
  readonly uptimeSeconds: number;
};

/** Set while an admin page renders so its footer is emitted by the Layout. */
const _adminFooterStore = { show: false };

/** Flag the current render as an admin page so its footer (with logout) shows. */
export const markAdminFooter = (): void => {
  _adminFooterStore.show = true;
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

/** Build the admin footer: Chobble link (plus the debug menu when present) on
 * the left, utility links on the right. */
export const adminFooterHtml = (debug: DebugFooterData | null): string =>
  `<footer class="admin-footer">` +
  `<div class="admin-footer-top">` +
  `<a href="https://github.com/chobbledotcom/tickets">${t(
    "admin.footer.chobble_tickets",
  )}</a>` +
  `<div class="admin-footer-links">` +
  `<a href="/admin/log">${t("nav.log")}</a>` +
  " &middot; " +
  `<a href="/admin/guide">${t("nav.guide")}</a>` +
  " &middot; " +
  `<a href="/admin/logout">${t("nav.logout")}</a>` +
  "</div>" +
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
  const show = _adminFooterStore.show;
  _adminFooterStore.show = false;
  if (!show) return "";
  const debug = isFooterDebugEnabled()
    ? {
        cacheStats: getAllCacheStats(),
        queries: getQueryLog(),
        renderTimeMs: performance.now() - getQueryLogStartTime(),
        uptimeSeconds: getUptimeSeconds(),
      }
    : null;
  return adminFooterHtml(debug);
};

/** Minimal HTML escaping for strings in the footer */
const escapeFooterHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
