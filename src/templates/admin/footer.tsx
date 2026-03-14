/**
 * Admin debug footer showing render time, SQL queries, and cache stats
 */

import { reduce } from "#fp";
import { type CacheStat, getAllCacheStats } from "#lib/cache-registry.ts";
import {
  getQueryLog,
  getQueryLogStartTime,
  isQueryLogEnabled,
  type QueryLogEntry,
} from "#lib/db/query-log.ts";

/** Data passed to the footer renderer */
export type DebugFooterData = {
  readonly renderTimeMs: number;
  readonly queries: QueryLogEntry[];
  readonly cacheStats: CacheStat[];
};

const sumDurations = reduce(
  (total: number, q: QueryLogEntry) => total + q.durationMs,
  0,
);

/** Render a single cache stat line */
const renderCacheStat = (stat: CacheStat): string =>
  stat.capacity
    ? `<li>${
      escapeFooterHtml(stat.name)
    }: ${stat.entries}/${stat.capacity}</li>`
    : `<li>${escapeFooterHtml(stat.name)}: ${stat.entries}</li>`;

/** Render the admin debug footer as an HTML string for injection before </body> */
export const debugFooterHtml = (data: DebugFooterData): string => {
  const { renderTimeMs, queries, cacheStats } = data;
  const totalSqlMs = sumDurations(queries);
  const otherMs = renderTimeMs - totalSqlMs;
  const totalCacheEntries = reduce(
    (total: number, s: CacheStat) => total + s.entries,
    0,
  )(cacheStats);

  return (
    `<footer class="debug-footer">` +
    `<p><a href="https://github.com/chobbledotcom/tickets">Chobble Tickets</a></p>` +
    `<details>` +
    `<summary>${renderTimeMs.toFixed(0)}ms` +
    ` &middot; ${queries.length} quer${queries.length === 1 ? "y" : "ies"} ${
      totalSqlMs.toFixed(0)
    }ms` +
    ` &middot; ${totalCacheEntries} cached</summary>` +
    `<p>Render: ${renderTimeMs.toFixed(1)}ms` +
    ` (sql ${totalSqlMs.toFixed(1)}ms + other ${otherMs.toFixed(1)}ms)</p>` +
    (queries.length > 0
      ? `<details><summary>SQL queries</summary><ul>` +
        queries
          .map(
            (q) =>
              `<li>${escapeFooterHtml(q.sql)} &mdash; ${
                q.durationMs.toFixed(1)
              }ms</li>`,
          )
          .join("") +
        `</ul></details>`
      : "") +
    (cacheStats.length > 0
      ? `<details><summary>Caches (${cacheStats.length})</summary><ul>` +
        cacheStats.map(renderCacheStat).join("") +
        `</ul></details>`
      : "") +
    `</details>` +
    `</footer>`
  );
};

/**
 * Return the admin debug footer HTML if query logging is active, otherwise "".
 * Called from the Layout template so the footer is part of the HTML string
 * before it is wrapped in a Response, avoiding response.text() on Bunny Edge.
 */
export const renderDebugFooter = (): string =>
  isQueryLogEnabled()
    ? debugFooterHtml({
      renderTimeMs: performance.now() - getQueryLogStartTime(),
      queries: getQueryLog(),
      cacheStats: getAllCacheStats(),
    })
    : "";

/** Minimal HTML escaping for strings in the footer */
const escapeFooterHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
