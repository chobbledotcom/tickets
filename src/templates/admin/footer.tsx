/**
 * Owner-only debug footer showing render time and SQL queries
 */

import type { QueryLogEntry } from "#lib/db/query-log.ts";

/** Render the owner debug footer as an HTML string for injection before </body> */
export const ownerFooterHtml = (
  renderTimeMs: number,
  queries: QueryLogEntry[],
): string =>
  `<footer class="debug-footer">` +
  `<p><a href="https://github.com/chobbledotcom/tickets">Chobble Tickets</a></p>` +
  `<details>` +
  `<summary>${renderTimeMs.toFixed(0)}ms</summary>` +
  `<ul>` +
  queries
    .map(
      (q) =>
        `<li>${escapeFooterHtml(q.sql)} &mdash; ${q.durationMs.toFixed(1)}ms</li>`,
    )
    .join("") +
  `</ul>` +
  `</details>` +
  `</footer>`;

/** Minimal HTML escaping for SQL strings in the footer */
const escapeFooterHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
