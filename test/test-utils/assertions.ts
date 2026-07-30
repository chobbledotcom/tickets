import { expect } from "@std/expect";
import { it } from "@std/testing/bdd";
import { once } from "#fp";
import { getSessionCookieName, parseFlashValue } from "#shared/cookies.ts";
import { BROKEN_IMAGE_PNG } from "#shared/images/broken.ts";

export const FLASH_TEST_ID = "t001";

export const expectStatus =
  (status: number) =>
  (response: Response): Response => {
    expect(response.status).toBe(status);
    return response;
  };

export const expectDatabaseResetRedirect = (response: Response): Response => {
  expectRedirectWithFlash("/setup/", "Database reset")(response);
  const sessionCookie = response.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${getSessionCookieName()}=`));
  expect(sessionCookie).toContain("Max-Age=0");
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

export const expectActivityLogShows = async (
  name: string,
  verb: string,
): Promise<void> => {
  const { adminGet } = await import("#test-utils/session.ts");
  const response = await adminGet("/admin/log");
  const body = await response.text();
  expect(body).toContain(name);
  expect(body).toContain(verb);
};

const listingActivityLogHasMessage = async (
  listingId: number,
  substring: string,
): Promise<boolean> => {
  const { getListingActivityLog } = await import("#test-utils/activity-log.ts");
  const entries = await getListingActivityLog(listingId);
  return entries.some((entry) => entry.message.includes(substring));
};

type ListingActivityLogCheck = (
  listingId: number,
  substring: string,
) => Promise<void>;

/** Assert whether the listing's activity log holds an entry whose message
 * includes `substring` — one check, specialised below into the "has it" and
 * "has not" forms the tests read with. */
const expectListingActivityLog =
  (present: boolean) =>
  async (listingId: number, substring: string): Promise<void> => {
    expect(await listingActivityLogHasMessage(listingId, substring)).toBe(
      present,
    );
  };

/** Assert the listing's activity log has an entry whose message includes `substring`. */
export const expectListingActivityLogContains: ListingActivityLogCheck =
  expectListingActivityLog(true);

/** Assert the listing's activity log has no entry whose message includes `substring`. */
export const expectListingActivityLogLacks: ListingActivityLogCheck =
  expectListingActivityLog(false);

export const expectTestAttendeeCsvColumns = (
  row: string | undefined,
  quantity = 1,
): void => {
  expect(row).toContain("John Doe");
  expect(row).toContain("john@example.com");
  expect(row).toContain(`,${quantity},`);
};

/** Asserts a response is a 200 CSV download with the standard
 *  Content-Disposition: attachment header, whose filename contains
 *  `filenameFragment` — the shared header contract behind every CSV export
 *  route (listing exports, calendar exports, etc). */
export const expectCsvDownloadHeaders = (
  response: Response,
  filenameFragment: string,
): void => {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  expect(response.headers.get("content-disposition")).toContain("attachment");
  expect(response.headers.get("content-disposition")).toContain(
    filenameFragment,
  );
};

/** Fetch a listing's CSV export as the given admin, assert 200, return the body. */
export const fetchListingExportCsv = async (
  listingId: number,
  cookie: string,
): Promise<string> => {
  const { awaitTestRequest } = await import("#test-utils/mocks.ts");
  const response = await awaitTestRequest(
    `/admin/listing/${listingId}/export`,
    { cookie },
  );
  expect(response.status).toBe(200);
  return await response.text();
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

/** PUT `{ name: "" }` to a JSON API entity endpoint and assert the standard
 *  400 "name cannot be empty" rejection. The PUT-name-empty validation is
 *  shared by every writable-named admin entity (holidays, groups, listings),
 *  so hoisting the assertion here keeps each api test focused on the
 *  behaviour specific to that resource. */
export const expectRejectsEmptyName = async (path: string): Promise<void> => {
  const { apiRequest } = await import("#test-utils/session.ts");
  await assertJson(
    apiRequest(path, { body: { name: "" }, method: "PUT" }),
    400,
    (body) => {
      expect(body.error).toBe("name cannot be empty");
    },
  );
};

/** DELETE a named resource via the admin JSON API with a confirmation and
 *  assert the standard `{ status: "ok" }` 200 response. */
export const assertApiDeleteOk = async (
  url: string,
  confirmationName: string,
): Promise<void> => {
  const { apiRequest } = await import("#test-utils/session.ts");
  await assertJson(
    apiRequest(url, {
      body: { confirm_identifier: confirmationName },
      method: "DELETE",
    }),
    200,
    (body) => {
      expect(body.status).toBe("ok");
    },
  );
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
  const response = await adminGet(path);
  return expectHtml(response, { contains: substrings, status: 200 });
};

/** Assert every substring appears in the HTML; returns the HTML for further
 *  checks. The positive half of {@link expectHtml}, for callers that already
 *  hold the body text rather than a `Response`. */
export const expectHtmlContains = (
  html: string,
  substrings: string[],
): string => {
  for (const s of substrings) expect(html).toContain(s);
  return html;
};

/** The one form control tag on a page with the given name — input, textarea,
 * or select — so a test can check the exact attributes a form serves
 * (default, bounds, required). */
export const inputNamed = (html: string, name: string): string => {
  // The lookahead keeps a longer tag like input-widget out, the whitespace
  // before name= keeps a longer attribute like data-name out, and escaping
  // keeps regex characters in a name literal.
  const literal = name.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  const tag = html.match(
    new RegExp(
      `<(?:input|textarea|select)(?=\\s)[^>]*\\sname="${literal}"[^>]*>`,
    ),
  )?.[0];
  if (!tag) throw new Error(`No control named ${name} on the page`);
  return tag;
};

/**
 * "Render once, assert many": for a suite that makes many assertions about one
 * admin page rendered from the standard fixture, this returns an assert
 * function shaped like {@link assertAdminHtml} minus the path — but the page
 * is fetched a single time, on the first call, and the same HTML serves every
 * later assertion. A 40-test suite that would otherwise re-render an identical
 * page 40 times (each render on a fresh per-test database) does the work once.
 *
 * Only for assertions against the page's DEFAULT state: a test that changes
 * settings, env, or fixture data to alter the page must fetch its own copy
 * (e.g. via {@link assertAdminHtml}) so it never reads the stale snapshot.
 * Call with no substrings to just get the cached HTML.
 */
export const cachedAdminPage = (
  path: string,
): ((...substrings: string[]) => Promise<string>) => {
  const load = once(async (): Promise<string> => {
    const { adminGet } = await import("#test-utils/session.ts");
    return expectHtml(await adminGet(path), { status: 200 });
  });
  return async (...substrings: string[]): Promise<string> =>
    expectHtmlContains(await load(), substrings);
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
): Promise<string> => expectHtml(response, { contains: substrings, status });

/** Return the complete table row containing the given text. */
export const tableRowContaining = (html: string, text: string): string => {
  for (
    let start = html.indexOf("<tr");
    start >= 0;
    start = html.indexOf("<tr", start + 1)
  ) {
    const end = html.indexOf("</tr>", start);
    if (end === -1) break;
    const row = html.slice(start, end + 5);
    if (row.includes(text)) return row;
  }
  throw new Error(`No table row containing "${text}" found`);
};

/** Assert an HTTP response's body HTML. Works with any request method —
 *  `adminGet`, `handleRequest(mockRequest(...))`, direct handler calls —
 *  because it takes the `Response` itself. Supports optional status check,
 *  positive (`contains`) and negative (`notContains`) substring assertions. */
export const expectHtml = async (
  response: Response,
  opts: {
    status?: number | undefined;
    contains?: string[] | undefined;
    notContains?: string[] | undefined;
  } = {},
): Promise<string> => {
  if (opts.status !== undefined) expect(response.status).toBe(opts.status);
  const html = await response.text();
  expectHtmlContains(html, opts.contains ?? []);
  for (const s of opts.notContains ?? []) expect(html).not.toContain(s);
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

/** A successful public booking redirects to the reserved/thank-you page
 *  carrying one or more attendee tokens in the query string. */
export const expectReservedRedirectWithTokens = (response: Response): void => {
  expectRedirect(response, /^\/ticket\/reserved\?tokens=.+$/);
};

/** Asserts each listing in `expectations` ended up with exactly `count` raw
 *  attendee rows, and (when given) that the single resulting attendee's
 *  `quantity` matches. This is the "who got booked, and for how many" check
 *  repeated after almost every multi-listing booking POST. */
export const expectAttendeeCounts = async (
  expectations: { count: number; listingId: number; quantity?: number }[],
): Promise<void> => {
  const { getAttendeesRaw } = await import("#shared/db/attendees/queries.ts");
  for (const { count, listingId, quantity } of expectations) {
    const attendees = await getAttendeesRaw(listingId);
    expect(attendees.length).toBe(count);
    if (quantity !== undefined) expect(attendees[0]?.quantity).toBe(quantity);
  }
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
export const parseFlashCookie = (
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
      await Promise.all([import("#routes"), import("#shared/forms/flash.tsx")]);
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
export const expectThrows = (
  fn: () => unknown,
  errorClass: any,
  pattern?: RegExp,
): void => {
  expect(fn).toThrow(errorClass);
  if (pattern !== undefined) expect(fn).toThrow(pattern);
};

/** Await `promise` expecting it to reject, and return the thrown error's
 *  message string. Useful when you need to assert on a substring of the
 *  message (Deno's `rejects.toThrow` doesn't return the message). */
export const rejectionMessage = async (
  promise: Promise<unknown>,
): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  return "";
};

/** Assert that HTML content is properly escaped — `<script>` shows as
 *  `&lt;script&gt;`. */
export const expectHtmlEscaped = (html: string): void => {
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
};

export const matchGroup = (text: string, pattern: RegExp, group = 1): string =>
  text.match(pattern)![group]!;

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
  /** Optional per-test preparation. Return a cleanup function to undo any
   * state the setup switched (e.g. the restore from `withEnv`) — module
   * state left switched leaks into every test that runs after this one. */
  setup?: () => Promise<(() => void) | undefined> | Promise<void>;
}

export const testRequiresAuth = (
  path: string,
  options: TestRequiresAuthOptions = {},
): void => {
  it("redirects to login when not authenticated", async () => {
    const cleanup = await options.setup?.();
    try {
      const { handleRequest } = await import("#routes");
      const { mockFormRequest, mockMultipartRequest, mockRequest } =
        await import("#test-utils/mocks.ts");
      const request = options.multipart
        ? mockMultipartRequest(path, options.body!)
        : options.method === "POST"
          ? mockFormRequest(path, options.body!)
          : mockRequest(path);
      const response = await handleRequest(request);
      expectAdminRedirect(response);
    } finally {
      cleanup?.();
    }
  });
};

/** The rendered attendee-editor line index for a listing's row (its FIRST
 * line, or the line on `packageGroupId`'s path), scraped from the form's
 * hidden `line_listing_<i>` / `line_package_<i>` inputs. Null when the
 * listing has no rendered line on that path. */
export const attendeeLineIndex = (
  html: string,
  listingId: number,
  packageGroupId = 0,
): string | null => {
  const listingFields = html.matchAll(
    /name="line_listing_(\d+)"[^>]*value="(\d+)"/g,
  );
  for (const match of listingFields) {
    if (Number(match[2]) !== listingId) continue;
    const index = match[1]!;
    const packageField = new RegExp(
      `name="line_package_${index}"[^>]*value="(\\d+)"`,
    ).exec(html);
    const lineGroup = packageField ? Number(packageField[1]) : 0;
    if (lineGroup === packageGroupId) return index;
  }
  return null;
};

/** Assert each stored column value is an `enc:` ciphertext envelope (encrypted
 * at rest, never plaintext). */
export const expectEncryptedAtRest = (
  ...values: Array<string | undefined>
): void => {
  for (const value of values) {
    expect(value?.startsWith("enc:")).toBe(true);
  }
};

/** Assert a response is the uncached red-pixel fallback for a broken image. */
export const expectBrokenImageResponse = async (
  response: Response,
): Promise<void> => {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(
    BROKEN_IMAGE_PNG,
  );
};
