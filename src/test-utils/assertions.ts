import { expect } from "@std/expect";
import { parseFlashValue } from "#lib/cookies.ts";

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

export const expectRedirect = (
  response: Response,
  ...patterns: (string | RegExp)[]
): string => {
  expect(response.status).toBe(302);
  response.body?.cancel();
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

export const expectFlash = (
  response: Response,
  // deno-lint-ignore no-explicit-any
  message: string | any,
  succeeded = true,
): Response => {
  response.body?.cancel();
  const cookies = response.headers.getSetCookie();
  const flash = cookies.find((c) => c.startsWith("flash_"));
  if (!flash) throw new Error("No flash cookie in response");
  const cookiePart = flash.split(";")[0] ?? "";
  const value = cookiePart.split("=").slice(1).join("=");
  const parsed = parseFlashValue(value);
  const actual = succeeded ? parsed.success : parsed.error;
  if (message !== undefined) expect(actual).toEqual(message);
  return response;
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

export const getHeader = (response: Response, name: string): string => {
  const value = response.headers.get(name);
  if (value === null) throw new Error(`Missing expected header: ${name}`);
  return value;
};

export const matchGroup = (
  text: string,
  pattern: RegExp,
  group = 1,
): string => {
  const m = text.match(pattern);
  if (!m?.[group]) {
    throw new Error(`No match for ${pattern} group ${group}`);
  }
  return m[group];
};