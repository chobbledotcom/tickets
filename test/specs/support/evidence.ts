import { parse } from "@std/csv/parse";
import { getSessionCookieName } from "#shared/cookies.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

/** The one cookie that authenticates a captured page. Other browser cookies do
 * not change which admin account sees it. */
export const sessionCookie = (
  browser: Pick<TestBrowser, "debugCookies">,
): string => {
  const name = getSessionCookieName();
  const value = browser.debugCookies().get(name);
  if (!value) throw new Error("The browser has no admin session cookie");
  return `${name}=${value}`;
};

/** The date column is what this story proves. Do not put attendee names or
 * contact details into a screenshot artifact. */
export const csvDateColumn = (csv: string): string =>
  ["Date", ...parse(csv, { skipFirstRow: true }).map((row) => row.Date)].join(
    "\n",
  );

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** The CSV is the outcome this story reads. Render its date column in the
 * evidence browser so its screenshot proves the exported date range. */
export const csvEvidencePage = (name: string, dates: string): string =>
  `data:text/html,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><style>:root{--border-radius:8px;--color-accent:#568038;--color-bg:#f1f5ed;--color-bg-secondary:#fff;--color-shadow:#2f4a2024;--color-text:#273320;--font-family:Arial,sans-serif}body{background:var(--color-bg);color:var(--color-text);font:16px var(--font-family);margin:0;padding:32px}main{background:var(--color-bg-secondary);border:1px solid #d7e1cf;border-top:6px solid var(--color-accent);border-radius:var(--border-radius);box-shadow:0 12px 28px var(--color-shadow);margin:auto;max-width:720px;padding:24px}h1{font-size:24px;margin:0 0 20px}pre{background:var(--color-bg);border:1px solid #d7e1cf;overflow-wrap:anywhere;padding:16px;white-space:pre-wrap}</style><main><h1>${escapeHtml(name)} attendee CSV</h1><pre>${escapeHtml(dates)}</pre></main>`)}`;
