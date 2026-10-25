/**
 * Page-body assertions: hold rendered HTML and assert what it shows —
 * substrings, table rows, form controls, select options — plus the whole-page
 * fetches (admin page, public page, cookie-carried request) behind them.
 *
 * `session.ts` is imported on first call, never statically: a static import
 * would load it into every test file that imports this module.
 */

import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { once } from "#fp";
import { BROKEN_IMAGE_PNG } from "#shared/images/broken.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { escapeForRegex } from "#test-utils/regex.ts";

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
  for (const s of substrings) assertStringIncludes(html, s);
  return html;
};

/** The one form control tag on a page with the given name — input, textarea,
 * or select — so a test can check the exact attributes a form serves
 * (default, bounds, required). */
export const inputNamed = (html: string, name: string): string => {
  // The lookahead keeps a longer tag like input-widget out, the whitespace
  // before name= keeps a longer attribute like data-name out, and escaping
  // keeps regex characters in a name literal.
  const tag = html.match(
    new RegExp(
      `<(?:input|textarea|select)(?=\\s)[^>]*\\sname="${escapeForRegex(name)}"[^>]*>`,
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
  const response = await awaitTestRequest(path, { cookie });
  return expectHtmlResponse(response, 200, ...substrings);
};

export const assertPublicHtml = async (
  path: string,
  ...substrings: string[]
): Promise<string> => {
  const response = await awaitTestRequest(path);
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
  for (const s of opts.notContains ?? []) assert(!html.includes(s));
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

/** Assert that HTML content is properly escaped — `<script>` shows as
 *  `&lt;script&gt;`. */
export const expectHtmlEscaped = (html: string): void => {
  assert(!html.includes("<script>"));
  assertStringIncludes(html, "&lt;script&gt;");
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
  const inner = html.match(
    new RegExp(
      `<select[^>]*aria-label="${escapeForRegex(ariaLabel)}"[^>]*>([\\s\\S]*?)<\\/select>`,
    ),
  )![1]!;
  return [...inner.matchAll(/<option[^>]*>([^<]+)</g)].map((m) => m[1]);
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

/** Assert a payment-failure response reads as the buyer's named refusal and
 *  carries no staff detail — the guard the payment-failure viewer tests
 *  share. The message names the branch's own buyer copy. */
export const expectBuyerRefusalWithoutStaffPanel = async (
  response: Response,
  message: string,
): Promise<void> => {
  const page = await response.text();
  assertStringIncludes(page, message);
  assert(!page.includes("Staff diagnostics"));
};
