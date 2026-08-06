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
  csv
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .map((line) => line.split(",", 1)[0])
    .join("\n");
