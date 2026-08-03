import { expect } from "@std/expect";
import { getSessionCookieName } from "#shared/cookies.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { expectFlash } from "#test-utils/assertions.ts";

export const extractCsrfToken = (html: string | null): string | null => {
  if (!html) return null;
  return extractInputValue(html, "csrf_token");
};

export const extractInputValue = (
  html: string,
  name: string,
): string | null => {
  const tags = html.match(/<input\b[^>]*>/gi) ?? [];
  const needle = `name="${name}"`;
  const tag = tags.find((t) => t.includes(needle));
  return tag?.match(/\bvalue="([^"]*)"/)?.[1] ?? null;
};

export const hasInputWithValue = (
  html: string,
  name: string,
  value: string,
): boolean => extractInputValue(html, name) === value;

export const inputTagWithValue = (html: string, value: string): string =>
  html.match(new RegExp(`<input\\b[^>]*value="${value}"[^>]*>`))?.[0] ?? "";

export const hasCheckedInput = (
  html: string,
  name: string,
  value: string,
): boolean => {
  const tags = html.match(/<input\b[^>]*>/gi) ?? [];
  const needle = `name="${name}"`;
  return tags.some(
    (t) =>
      t.includes(needle) &&
      t.includes(`value="${value}"`) &&
      /\bchecked(?=[\s/>])/.test(t),
  );
};

export const hasSelectedOption = (html: string, value: string): boolean => {
  const tags = html.match(/<option\b[^>]*>/gi) ?? [];
  return tags.some(
    (t) => t.includes(`value="${value}"`) && /\bselected(?=[\s/>])/.test(t),
  );
};

export const getAdminLoginCsrfToken = (html: string | null): string | null =>
  extractCsrfToken(html);

export const getJoinCsrfToken = (html: string | null): string | null =>
  extractCsrfToken(html);

export const requireJoinCsrfToken = (html: string | null): string => {
  const token = extractCsrfToken(html);
  if (!token) throw new Error("Failed to get CSRF token for join flow");
  return token;
};

export const csrfTokenOrSignedFallback = async (
  html: string,
): Promise<string> => extractCsrfToken(html) ?? (await signCsrfToken());

export const getSetupCsrfToken = (html: string | null): string | null =>
  extractCsrfToken(html);

export const getTicketCsrfToken = (html: string | null): string | null =>
  extractCsrfToken(html);

/** GETs a page and returns its rendered HTML plus its signed CSRF token. This
 *  is the shared first half of any test that must inspect the page —
 *  checking rendered content, a sold-out label, an iframe flag — before
 *  submitting a form, rather than going straight through
 *  `submitMultiTicketForm`. */
export const getPageWithCsrf = async (
  path: string,
): Promise<{ csrfToken: string; html: string }> => {
  const { handleRequest } = await import("#routes");
  const { mockRequest } = await import("#test-utils/mocks.ts");
  const response = await handleRequest(mockRequest(path));
  const html = await response.text();
  const csrfToken = extractCsrfToken(html);
  if (!csrfToken) throw new Error(`Failed to get CSRF token from ${path}`);
  return { csrfToken, html };
};

export const getPageCsrfToken = async (path: string): Promise<string> =>
  (await getPageWithCsrf(path)).csrfToken;

export const getCsrfTokenFromCookie = async (
  cookie: string,
): Promise<string | null> => {
  const { getSession } = await import("#shared/db/sessions.ts");
  const sessionMatch = cookie.match(
    new RegExp(`${getSessionCookieName()}=([^;]+)`),
  );
  if (!sessionMatch?.[1]) return null;

  const sessionToken = sessionMatch[1];
  const session = await getSession(sessionToken);
  return session?.csrf_token ?? null;
};

export const submitJoinForm = async (
  inviteCode: string,
  data: { password: string; password_confirm: string },
): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  const { mockFormRequest, mockRequest } = await import("#test-utils/mocks.ts");
  const requireJoinCsrfTokenImport = await import("#test-utils/csrf.ts");
  const joinGetResponse = await handleRequest(
    mockRequest(`/join/${inviteCode}`),
  );
  const joinHtml = await joinGetResponse.text();
  const joinCsrf = requireJoinCsrfTokenImport.requireJoinCsrfToken(joinHtml);
  return handleRequest(
    mockFormRequest(`/join/${inviteCode}`, { ...data, csrf_token: joinCsrf }),
  );
};

export const submitTicketForm = async (
  slug: string,
  data: Record<string, string>,
): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  const { mockRequest, mockTicketFormRequest } = await import(
    "#test-utils/mocks.ts"
  );
  const getResponse = await handleRequest(mockRequest(`/ticket/${slug}`));
  const html = await getResponse.text();
  const csrfToken = await csrfTokenOrSignedFallback(html);
  const normalizedData = normalizeSingleListingFields(data, html);
  return handleRequest(mockTicketFormRequest(slug, normalizedData, csrfToken));
};

/** POSTs a ticket form carrying no CSRF token at all and asserts the
 *  standard "Invalid or expired form" rejection — the shared missing-CSRF
 *  check behind single- and multi-listing ticket routes alike. */
export const expectMissingCsrfRejected = async (
  path: string,
  data: Record<string, string>,
): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  const { mockFormRequest } = await import("#test-utils/mocks.ts");
  const response = await handleRequest(mockFormRequest(path, data));
  expect(response.status).toBe(302);
  expectFlash(
    response,
    expect.stringContaining("Invalid or expired form"),
    false,
  );
  return response;
};

export const submitMultiTicketForm = async (
  slug: string,
  data: Record<string, string>,
): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  const { mockFormRequest } = await import("#test-utils/mocks.ts");
  const path = `/ticket/${slug}`;
  const { csrfToken } = await getPageWithCsrf(path);
  return handleRequest(
    mockFormRequest(
      path,
      { ...data, csrf_token: csrfToken },
      `csrf_token=${csrfToken}`,
    ),
  );
};

/** Submits the joint ticket form as "John Doe", booking `quantity1` of
 *  listing1 and `quantity2` of listing2 — the generic two-listing booking
 *  shape reused by almost every multi-listing test scenario that doesn't
 *  care about the buyer's identity, only about what happens to the two
 *  listings and their quantities. */
export const bookTwoListings = (
  slug: string,
  listing1Id: number,
  quantity1: string,
  listing2Id: number,
  quantity2: string,
): Promise<Response> =>
  submitMultiTicketForm(slug, {
    email: "john@example.com",
    name: "John Doe",
    [`quantity_${listing1Id}`]: quantity1,
    [`quantity_${listing2Id}`]: quantity2,
  });

/** `bookTwoListings` specialised to one of each — the most common case. */
export const bookOneEachViaTicketForm = (
  slug: string,
  listing1Id: number,
  listing2Id: number,
): Promise<Response> => bookTwoListings(slug, listing1Id, "1", listing2Id, "1");

/** Submits the joint ticket form as "Test User" <test@example.com>, booking
 *  `quantity1` of listing1 and `quantity2` of listing2, with optional extra
 *  form fields (e.g. a chosen `date`) merged in — the generic two-listing
 *  "Test User" booking shape reused by several date/validation scenarios. */
export const bookTwoListingsAsTestUser = (
  slug: string,
  listing1Id: number,
  quantity1: string,
  listing2Id: number,
  quantity2: string,
  extraFields: Record<string, string> = {},
): Promise<Response> =>
  submitMultiTicketForm(slug, {
    ...extraFields,
    email: "test@example.com",
    name: "Test User",
    [`quantity_${listing1Id}`]: quantity1,
    [`quantity_${listing2Id}`]: quantity2,
  });

/** Books one of each of two listings and asserts the booking was turned away
 *  with a 302 redirect and a flash error containing `flashSubstring` — the
 *  shared "attempted booking, got rejected" assertion behind many capacity /
 *  payment-provider / CSRF edge-case tests. */
export const expectBookOneEachRejected = async (
  slug: string,
  listing1Id: number,
  listing2Id: number,
  flashSubstring: string,
): Promise<void> => {
  const response = await bookOneEachViaTicketForm(slug, listing1Id, listing2Id);
  expect(response.status).toBe(302);
  expectFlash(response, expect.stringContaining(flashSubstring), false);
};

const extractQuantityListingId = (html: string): string | null => {
  const match = html.match(/name="quantity_(\d+)"/);
  return match?.[1] ?? null;
};

export const normalizeSingleListingFields = (
  data: Record<string, string>,
  html: string,
): Record<string, string> => {
  const listingId = extractQuantityListingId(html);
  if (!listingId) return data;
  const result = { ...data };
  if (!(`quantity_${listingId}` in result)) {
    if ("quantity" in result) {
      result[`quantity_${listingId}`] = result.quantity;
      delete result.quantity;
    } else {
      result[`quantity_${listingId}`] = "1";
    }
  }
  if ("custom_price" in result && !(`custom_price_${listingId}` in result)) {
    result[`custom_price_${listingId}`] = result.custom_price;
    delete result.custom_price;
  }
  return result;
};
