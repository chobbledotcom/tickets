import { getSessionCookieName } from "#shared/cookies.ts";
import { signCsrfToken } from "#shared/csrf.ts";

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

export const getPageCsrfToken = async (path: string): Promise<string> => {
  const { handleRequest } = await import("#routes");
  const { mockRequest } = await import("#test-utils/mocks.ts");
  const response = await handleRequest(mockRequest(path));
  const html = await response.text();
  const token = extractCsrfToken(html);
  if (!token) throw new Error(`Failed to get CSRF token from ${path}`);
  return token;
};

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

export const submitMultiTicketForm = async (
  slug: string,
  data: Record<string, string>,
): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  const { mockFormRequest, mockRequest } = await import("#test-utils/mocks.ts");
  const path = `/ticket/${slug}`;
  const getResponse = await handleRequest(mockRequest(path));
  const csrfToken = extractCsrfToken(await getResponse.text());
  if (!csrfToken) throw new Error("No CSRF token found on ticket page");
  return handleRequest(
    mockFormRequest(
      path,
      { ...data, csrf_token: csrfToken },
      `csrf_token=${csrfToken}`,
    ),
  );
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
