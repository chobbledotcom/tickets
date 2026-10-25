/**
 * Redirect and flash assertions: where a response points, which flash message
 * travels with it, and what the destination page renders once the redirect is
 * followed.
 *
 * `session.ts` is imported on first call, never statically: it pulls the whole
 * app (`#routes`) in, and this module sits in the module graph of every test
 * file.
 */

import { assertExists, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { handleRequest } from "#routes";
import { getSessionCookieName, parseFlashValue } from "#shared/cookies.ts";
import type { Flash } from "#shared/flash-context.ts";
import { renderError, renderSuccess } from "#shared/forms/flash.tsx";
import { mockRequest } from "#test-utils/mocks.ts";

export const FLASH_TEST_ID = "t001";

export const expectDatabaseResetRedirect = (response: Response): Response => {
  expectRedirectWithFlash("/setup/", "Database reset")(response);
  const sessionCookie = response.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${getSessionCookieName()}=`));
  assertExists(sessionCookie);
  assertStringIncludes(sessionCookie, "Max-Age=0");
  return response;
};

export const expectAdminLoginSuccess = async (
  response: Response,
): Promise<void> => {
  await expectFlashRedirect("/admin", "Logged in")(response);
  const sessionCookie = response.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${getSessionCookieName()}=`));
  expect(sessionCookie).toBeDefined();
};

export const assertFormRedirect = async (
  path: string,
  data: Record<string, string>,
  redirectTo: string,
  flashMessage: string,
): Promise<Response> => {
  const { adminFormPost } = await import("#test-utils/session.ts");
  const { response } = await adminFormPost(path, data);
  // Cookie-only: callers include the database-reset flow, whose redirect target
  // can't be followed (the reset wipes the DB and the admin session).
  expectRedirectWithFlash(redirectTo, flashMessage)(response);
  return response;
};

export const expectRedirect = (
  response: Response,
  ...patterns: (string | RegExp)[]
): string => {
  expect(response.status).toBe(302);
  const location = getHeader(response, "location");
  for (const p of patterns) {
    if (typeof p === "string") {
      assertStringIncludes(location, p);
    } else {
      expect(location).toMatch(p);
    }
  }
  return location;
};

export const expectAdminRedirect = (response: Response): string =>
  expectRedirect(response, "/admin");

/** A successful public booking redirects to the reserved/thank-you page
 * carrying one or more attendee tokens in the query string. */
export const expectReservedRedirectWithTokens = (response: Response): void => {
  expectRedirect(response, /^\/ticket\/reserved\?tokens=.+$/);
};

/** The exact `form` search param of a redirect's Location (the flash anchor
 * targeting a specific CsrfForm), or null when absent. Parsed rather than
 * substring-matched so a wrong-but-prefixed form id (settings-square vs
 * settings-square-webhook) can't pass. */
export const redirectFormId = (response: Response): string | null =>
  new URL(getHeader(response, "location"), "http://localhost").searchParams.get(
    "form",
  );

/** Parse the `flash_*` cookie off a redirect response into its message fields. */
export const parseFlashCookie = (response: Response): Flash => {
  const cookies = response.headers.getSetCookie();
  const flash = cookies.find((c) => c.startsWith("flash_"))!;
  const cookiePart = flash.split(";")[0]!;
  const value = cookiePart.split("=").slice(1).join("=");
  return parseFlashValue(value);
};

export const expectFlash = (
  response: Response,
  message: string | any,
  succeeded = true,
): Response => {
  const parsed = parseFlashCookie(response);
  const actual = succeeded ? parsed.success : parsed.error;
  if (message !== undefined) expect(actual).toEqual(message);
  return response;
};

/** Assert the redirect carries a real, non-empty flash message of the given
 *  level. `toBeDefined()` would let `null`/`""` slip through — a flash-less
 *  redirect must fail this. Curried so the error and success checks share one
 *  body. */
export const expectFlashMessage =
  (level: "error" | "success") =>
  (response: Response): void => {
    const message = parseFlashCookie(response)[level];
    expect(message).toEqual(expect.any(String));
    expect(message).not.toBe("");
  };
export const expectFlashError = expectFlashMessage("error");
export const expectFlashSuccess = expectFlashMessage("success");

/** Assert a 302 redirect carrying an error flash whose message contains `text`. */
export const expectErrorFlash = (response: Response, text: string): void => {
  expect(response.status).toBe(302);
  expectFlash(response, expect.stringContaining(text), false);
};

export const expectRedirectWithFlash =
  (location: string, message?: string | any, succeeded = true) =>
  (response: Response): Response => {
    const actualLocation = expectRedirect(response);
    const url = new URL(actualLocation, "http://localhost");
    const flashId = url.searchParams.get("flash");
    expect(flashId, actualLocation).not.toBeNull();
    url.searchParams.delete("flash");
    const clean = url.pathname + url.search + url.hash;
    expect(clean).toBe(location);
    expectFlash(response, message, succeeded);
    return response;
  };

/** Lazy default follow cookie: the owner test session, which can GET any admin
 *  page, so the destination renders for the common admin case without the
 *  caller threading a cookie through. */
const defaultFollowCookie = async (): Promise<string> => {
  const { testCookie } = await import("#test-utils/session.ts");
  return testCookie();
};

/** The session cookie this response sets or clears (login establishes a new one,
 *  logout clears it), or null when the redirect leaves the session untouched.
 *  Lets the follow use the session the action actually establishes — so a
 *  logout is followed logged-out, matching what the browser would render —
 *  instead of a stale default owner session. */
const sessionCookieFromResponse = (response: Response): string | null => {
  const prefix = `${getSessionCookieName()}=`;
  const match = response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => c?.startsWith(prefix));
  return match ?? null;
};

/**
 * Curried, mandatory-flash redirect assertion — reach for this after almost
 * every admin action that ends in a redirect. Asserts that `response`:
 *   1. is a 302 to `location` (the `?flash=<id>` tracking param is ignored),
 *   2. carries a flash cookie whose message satisfies `message` (a string or an
 *      asymmetric matcher such as `expect.stringContaining(...)`), and
 *   3. RENDERS that flash where the operator lands: it follows the redirect,
 *      carrying the flash cookie + a session cookie, and asserts the rendered
 *      banner (built from the real cookie message) is in the returned HTML.
 *
 * Step 3 is the whole point — a handler can set a perfect flash cookie that the
 * destination page silently drops, which a cookie-only assertion never catches.
 * The message is mandatory: "we were just redirected" verifies almost nothing.
 * For the genuinely flash-less redirects — payment/checkout hops, the public
 * success page, API responses, and auth bounces to /admin/login — use
 * `expectRedirect` instead.
 *
 * The follow uses, in order: an explicit `cookie`; the session the response
 * itself sets or clears (so a login is followed as the new user and a logout as
 * logged-out, matching the browser); otherwise the owner test session. So even
 * an auth-mutating redirect renders the page the real user would land on.
 */
export const expectFlashRedirect =
  (
    location: string,
    message: string | any,
    succeeded = true,
    cookie?: string,
  ) =>
  async (response: Response): Promise<Response> => {
    expectRedirectWithFlash(location, message, succeeded)(response);

    const followed = await followRedirectWithFlash(
      response,
      handleRequest,
      cookie ??
        sessionCookieFromResponse(response) ??
        (await defaultFollowCookie()),
    );
    const html = await followed.text();
    const parsed = parseFlashCookie(response);
    const actual = succeeded ? parsed.success : parsed.error;
    // A verified flash redirect must carry a non-empty message at the asserted
    // level; without this, renderSuccess("")/renderError("") is "" and
    // counting "" occurrences would pass vacuously without proving any banner.
    expect(actual).toBeTruthy();
    // Exactly once: catches both the dropped-flash bug (zero) and double-render
    // (two), e.g. a page banner plus a structural Layout/CsrfForm one.
    const banner = succeeded ? renderSuccess(actual) : renderError(actual);
    expect(html.split(banner).length - 1).toBe(1);
    return response;
  };

export const flashCookieHeader = (
  message: string,
  succeeded = true,
): string => {
  const type = succeeded ? "s" : "e";
  const payload = JSON.stringify({ m: message, t: type });
  return `flash_${FLASH_TEST_ID}=${encodeURIComponent(payload)}`;
};

export const expectCheckoutRedirect = (response: Response): string =>
  expectRedirect(response, /^https:\/\//);

export const followRedirect = async (
  response: Response,
  handler: (request: Request) => Promise<Response>,
): Promise<Response> => handler(mockRequest(expectRedirect(response)));

export const followRedirectWithFlash = async (
  response: Response,
  handler: (request: Request) => Promise<Response>,
  extraCookie?: string,
): Promise<Response> => {
  const location = expectRedirect(response);
  const setCookies = response.headers.getSetCookie();
  const flashCookie = setCookies
    .map((c) => c.split(";")[0])
    .filter((c) => c?.startsWith("flash_"))
    .join("; ");
  const cookie = [flashCookie, extraCookie].filter(Boolean).join("; ");
  return handler(mockRequest(location, cookie ? { headers: { cookie } } : {}));
};

export const getHeader = (response: Response, name: string): string =>
  response.headers.get(name)!;
