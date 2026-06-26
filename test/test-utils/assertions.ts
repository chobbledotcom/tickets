import { expect } from "@std/expect";
import { it } from "@std/testing/bdd";
import { getSessionCookieName, parseFlashValue } from "#shared/cookies.ts";

export const FLASH_TEST_ID = "t001";

export const expectStatus =
  (status: number) =>
  (response: Response): Response => {
    expect(response.status).toBe(status);
    return response;
  };

export const expectJsonResponse =
  // deno-lint-ignore no-explicit-any
    <T = any>(status: number, assertions?: (body: T) => void) =>
    async (response: Response): Promise<T> => {
      expect(response.status).toBe(status);
      const body = (await response.json()) as T;
      assertions?.(body);
      return body;
    };

// deno-lint-ignore no-explicit-any
export const assertJson = async <T = any>(
  request: Promise<Response>,
  status: number,
  assertions?: (body: T) => void,
): Promise<T> => {
  const response = await request;
  return expectJsonResponse<T>(status, assertions)(response);
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

export const assertAdminHtml = async (
  path: string,
  ...substrings: string[]
): Promise<string> => {
  const { adminGet } = await import("#test-utils/session.ts");
  const { response } = await adminGet(path);
  const html = await response.text();
  for (const s of substrings) expect(html).toContain(s);
  return html;
};

export const assertAdminHtmlWithCookie = async (
  path: string,
  cookie: string,
  ...substrings: string[]
): Promise<string> => {
  const { awaitTestRequest } = await import("#test-utils/mocks.ts");
  const response = await awaitTestRequest(path, { cookie });
  return expectHtmlResponse(response, 200, ...substrings);
};

export const assertPublicHtml = async (
  path: string,
  ...substrings: string[]
): Promise<string> => {
  const { handleRequest } = await import("#routes");
  const { mockRequest } = await import("#test-utils/mocks.ts");
  const response = await handleRequest(mockRequest(path));
  return expectHtmlResponse(response, 200, ...substrings);
};

export const expectHtmlResponse = async (
  response: Response,
  status: number,
  ...substrings: string[]
): Promise<string> => {
  expect(response.status).toBe(status);
  const html = await response.text();
  for (const s of substrings) {
    expect(html).toContain(s);
  }
  return html;
};

// A booking's quantity cell only proves the bookings summary is right if it
// sits in the same table row as its listing link — otherwise swapping two
// bookings' quantities would still pass. The tempered `(?!</tr>)` keeps the
// match inside one <tr>.
export const expectListingRowQuantity = (
  html: string,
  listingId: number,
  quantity: number,
): void => {
  expect(html).toMatch(
    new RegExp(
      `/admin/listing/${listingId}"(?:(?!</tr>)[\\s\\S])*?<td class="col-quantity">${quantity}</td>`,
    ),
  );
};

export const expectRedirect = (
  response: Response,
  ...patterns: (string | RegExp)[]
): string => {
  expect(response.status).toBe(302);
  const location = getHeader(response, "location");
  for (const p of patterns) {
    if (typeof p === "string") {
      expect(location).toContain(p);
    } else {
      expect(location).toMatch(p);
    }
  }
  return location;
};

export const expectAdminRedirect = (response: Response): string =>
  expectRedirect(response, "/admin");

/** Parse the `flash_*` cookie off a redirect response into its message fields. */
const parseFlashCookie = (
  response: Response,
): ReturnType<typeof parseFlashValue> => {
  const cookies = response.headers.getSetCookie();
  const flash = cookies.find((c) => c.startsWith("flash_"))!;
  const cookiePart = flash.split(";")[0]!;
  const value = cookiePart.split("=").slice(1).join("=");
  return parseFlashValue(value);
};

export const expectFlash = (
  response: Response,
  // deno-lint-ignore no-explicit-any
  message: string | any,
  succeeded = true,
): Response => {
  const parsed = parseFlashCookie(response);
  const actual = succeeded ? parsed.success : parsed.error;
  if (message !== undefined) expect(actual).toEqual(message);
  return response;
};

/** Assert a 302 redirect carrying an error flash whose message contains `text`. */
export const expectErrorFlash = (response: Response, text: string): void => {
  expect(response.status).toBe(302);
  expectFlash(response, expect.stringContaining(text), false);
};

export const expectRedirectWithFlash =
  // deno-lint-ignore no-explicit-any
    (location: string, message?: string | any, succeeded = true) =>
    (response: Response): Response => {
      const actualLocation = expectRedirect(response);
      const url = new URL(actualLocation, "http://localhost");
      const flashId = url.searchParams.get("flash");
      expect(flashId).toBeDefined();
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
    // deno-lint-ignore no-explicit-any
    message: string | any,
    succeeded = true,
    cookie?: string,
  ) =>
  async (response: Response): Promise<Response> => {
    expectRedirectWithFlash(location, message, succeeded)(response);

    const [{ handleRequest }, { renderError, renderSuccess }] =
      await Promise.all([import("#routes"), import("#shared/forms.tsx")]);
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
): Promise<Response> => {
  const { mockRequest } = await import("#test-utils/mocks.ts");
  return handler(mockRequest(expectRedirect(response)));
};

export const followRedirectWithFlash = async (
  response: Response,
  handler: (request: Request) => Promise<Response>,
  extraCookie?: string,
): Promise<Response> => {
  const { mockRequest } = await import("#test-utils/mocks.ts");
  const location = expectRedirect(response);
  const setCookies = response.headers.getSetCookie();
  const flashCookie = setCookies
    .map((c) => c.split(";")[0])
    .filter((c) => c?.startsWith("flash_"))
    .join("; ");
  const cookie = [flashCookie, extraCookie].filter(Boolean).join("; ");
  return handler(mockRequest(location, cookie ? { headers: { cookie } } : {}));
};

export const expectResultError =
  (expectedError: string) =>
  <T extends { ok: boolean; error?: string }>(result: T): T => {
    expect(result.ok).toBe(false);
    if (!result.ok && "error" in result) {
      expect(result.error).toBe(expectedError);
    }
    return result;
  };

export const expectResultNotFound = <
  T extends { ok: boolean; notFound?: boolean },
>(
  result: T,
): T => {
  expect(result.ok).toBe(false);
  expect("notFound" in result && result.notFound).toBe(true);
  return result;
};

export const getHeader = (response: Response, name: string): string =>
  response.headers.get(name)!;

/** Assert `fn` throws an error of `errorClass` and (optionally) whose message
 *  matches `pattern`. Runs `fn` twice — once per assertion — so only use for
 *  idempotent predicates (validators, pure checks), not stateful operations. */
// deno-lint-ignore no-explicit-any
export const expectThrows = <E extends Error>(
  fn: () => unknown,
  errorClass: any,
  pattern?: RegExp,
): void => {
  expect(fn).toThrow(errorClass);
  if (pattern !== undefined) expect(fn).toThrow(pattern);
};

export const matchGroup = (
  text: string,
  pattern: RegExp,
  group = 1,
): string => {
  return text.match(pattern)![group]!;
};

/** Visible text labels of every `<option>` inside the `<select
 *  aria-label="…">` dropdown, in document order. Includes disabled and prompt
 *  options, so callers see exactly what the user sees — e.g. the "Select a
 *  date" clear option the date picker splices in between past and future
 *  dates. */
export const selectOptionLabels = (
  html: string,
  ariaLabel: string,
): (string | undefined)[] => {
  const escaped = ariaLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const inner = html.match(
    new RegExp(
      `<select[^>]*aria-label="${escaped}"[^>]*>([\\s\\S]*?)<\\/select>`,
    ),
  )![1]!;
  return [...inner.matchAll(/<option[^>]*>([^<]+)</g)].map((m) => m[1]);
};

interface TestRequiresAuthOptions {
  body?: Record<string, string>;
  method?: "GET" | "POST";
  multipart?: boolean;
  setup?: () => Promise<void>;
}

export const testRequiresAuth = (
  path: string,
  options: TestRequiresAuthOptions = {},
): void => {
  it("redirects to login when not authenticated", async () => {
    await options.setup?.();
    const { handleRequest } = await import("#routes");
    const { mockFormRequest, mockMultipartRequest, mockRequest } = await import(
      "#test-utils/mocks.ts"
    );
    const request = options.multipart
      ? mockMultipartRequest(path, options.body!)
      : options.method === "POST"
        ? mockFormRequest(path, options.body!)
        : mockRequest(path);
    const response = await handleRequest(request);
    expectAdminRedirect(response);
  });
};
