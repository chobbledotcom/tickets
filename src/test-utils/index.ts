/**
 * Test utilities for the ticket reservation system
 */

import { createClient } from "@libsql/client";
import { clearEncryptionKeyCache } from "#lib/crypto.ts";
import { setDb } from "#lib/db/client.ts";
import { createEvent, type EventInput } from "#lib/db/events.ts";
import { initDb } from "#lib/db/migrations/index.ts";
import { getSession, resetSessionCache } from "#lib/db/sessions.ts";
import { clearSetupCompleteCache, completeSetup } from "#lib/db/settings.ts";

/**
 * Default test admin password
 */
export const TEST_ADMIN_PASSWORD = "testpassword123";

/**
 * Test encryption key (32 bytes base64-encoded)
 * This is a valid AES-256 key for testing purposes only
 */
export const TEST_ENCRYPTION_KEY =
  "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

/**
 * Set up test encryption key in environment
 * Also enables fast PBKDF2 hashing for tests
 */
export const setupTestEncryptionKey = (): void => {
  Deno.env.set("DB_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  Deno.env.set("TEST_PBKDF2_ITERATIONS", "1"); // Enable fast password hashing for tests
  clearEncryptionKeyCache();
};

/**
 * Clear test encryption key from environment
 */
export const clearTestEncryptionKey = (): void => {
  Deno.env.delete("DB_ENCRYPTION_KEY");
  Deno.env.delete("TEST_PBKDF2_ITERATIONS");
  clearEncryptionKeyCache();
};

/**
 * Create an in-memory database for testing
 * Also sets up the test encryption key and clears caches
 */
export const createTestDb = async (): Promise<void> => {
  setupTestEncryptionKey();
  clearSetupCompleteCache();
  resetSessionCache();
  const client = createClient({ url: ":memory:" });
  setDb(client);
  await initDb();
};

/**
 * Create an in-memory database with setup already completed
 * This is the common case for most tests
 * Also sets up the test encryption key
 */
export const createTestDbWithSetup = async (
  currency = "GBP",
): Promise<void> => {
  await createTestDb();
  await completeSetup(TEST_ADMIN_PASSWORD, currency);
};

/**
 * Reset the database connection and clear caches
 */
export const resetDb = (): void => {
  setDb(null);
  clearSetupCompleteCache();
  resetSessionCache();
};

/**
 * Create a mock Request object with a custom host
 */
export const mockRequestWithHost = (
  path: string,
  host: string,
  options: RequestInit = {},
): Request => {
  const headers = new Headers(options.headers);
  headers.set("host", host);
  return new Request(`http://${host}${path}`, { ...options, headers });
};

/**
 * Create a mock Request object (defaults to localhost)
 */
export const mockRequest = (path: string, options: RequestInit = {}): Request =>
  mockRequestWithHost(path, "localhost", options);

/**
 * Create a mock POST request with form data
 */
export const mockFormRequest = (
  path: string,
  data: Record<string, string>,
  cookie?: string,
): Request => {
  const body = new URLSearchParams(data).toString();
  const headers: HeadersInit = {
    "content-type": "application/x-www-form-urlencoded",
    host: "localhost",
  };
  if (cookie) {
    headers.cookie = cookie;
  }
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body,
  });
};

/**
 * Wait for a specified number of milliseconds
 */
export const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Generate a random string of specified length
 */
export const randomString = (length: number): string => {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

/**
 * Get CSRF token from a session cookie string
 */
export const getCsrfTokenFromCookie = async (
  cookie: string,
): Promise<string | null> => {
  const sessionMatch = cookie.match(/__Host-session=([^;]+)/);
  if (!sessionMatch?.[1]) return null;

  const sessionToken = sessionMatch[1];
  const session = await getSession(sessionToken);
  return session?.csrf_token ?? null;
};

/**
 * Extract a named cookie value from set-cookie header
 */
const getCookieValue = (
  setCookie: string | null,
  name: string,
): string | null => {
  if (!setCookie) return null;
  const match = setCookie.match(new RegExp(`${name}=([^;]+)`));
  return match?.[1] ?? null;
};

/**
 * Extract setup CSRF token from set-cookie header
 */
export const getSetupCsrfToken = (setCookie: string | null): string | null =>
  getCookieValue(setCookie, "setup_csrf");

/**
 * Create a mock setup POST request with CSRF token
 */
export const mockSetupFormRequest = (
  data: Record<string, string>,
  csrfToken: string,
): Request => {
  return mockFormRequest(
    "/setup",
    { ...data, csrf_token: csrfToken },
    `setup_csrf=${csrfToken}`,
  );
};

/**
 * Extract ticket CSRF token from set-cookie header
 */
export const getTicketCsrfToken = (setCookie: string | null): string | null =>
  getCookieValue(setCookie, "csrf_token");

/**
 * Create a mock ticket form POST request with CSRF token
 */
export const mockTicketFormRequest = (
  slug: string,
  data: Record<string, string>,
  csrfToken: string,
): Request => {
  return mockFormRequest(
    `/ticket/${slug}`,
    { ...data, csrf_token: csrfToken },
    `csrf_token=${csrfToken}`,
  );
};

/**
 * Options for testRequest helper
 */
interface TestRequestOptions {
  /** Full cookie string (use when you have raw set-cookie value) */
  cookie?: string;
  /** HTTP method (defaults to GET, or POST if data is provided) */
  method?: string;
  /** Form data for POST requests */
  data?: Record<string, string>;
}

/**
 * Create a test request with common options
 * Simplifies the verbose new Request() pattern in tests
 *
 * @example
 * // Simple GET
 * testRequest("/admin/")
 *
 * // GET with session token
 * testRequest("/admin/logout", token)
 *
 * // POST with form data (no auth)
 * testRequest("/admin/login", null, { data: { password: "test" } })
 *
 * // POST with session and form data
 * testRequest("/admin/event/new", token, { data: { name: "Event" } })
 */
export const testRequest = (
  path: string,
  token?: string | null,
  options: TestRequestOptions = {},
): Request => {
  const { cookie, method, data } = options;
  const headers: Record<string, string> = { host: "localhost" };

  if (token) {
    headers.cookie = `__Host-session=${token}`;
  } else if (cookie) {
    headers.cookie = cookie;
  }

  if (data) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    return new Request(`http://localhost${path}`, {
      method: method ?? "POST",
      headers,
      body: new URLSearchParams(data).toString(),
    });
  }

  return new Request(`http://localhost${path}`, {
    method: method ?? "GET",
    headers,
  });
};

/**
 * Create and execute a test request, returning the response
 * Combines testRequest() and handleRequest() for cleaner test code
 *
 * @example
 * // Simple GET
 * const response = await awaitTestRequest("/admin/")
 *
 * // GET with session token
 * const response = await awaitTestRequest("/admin/logout", token)
 *
 * // GET with cookie (from login response)
 * const response = await awaitTestRequest("/admin/", { cookie })
 *
 * // POST with form data
 * const response = await awaitTestRequest("/admin/login", { data: { password: "test" } })
 */
export const awaitTestRequest = async (
  path: string,
  tokenOrOptions?: string | TestRequestOptions | null,
): Promise<Response> => {
  const { handleRequest } = await import("#src/server.ts");
  if (typeof tokenOrOptions === "object" && tokenOrOptions !== null) {
    return handleRequest(testRequest(path, null, tokenOrOptions));
  }
  return handleRequest(testRequest(path, tokenOrOptions));
};

/** Counter for generating unique test slugs */
const slugCounter = { value: 0 };

/** Reset test slug counter (call in beforeEach) */
export const resetTestSlugCounter = (): void => {
  slugCounter.value = 0;
};

/** Generate a unique test slug */
export const generateTestSlug = (): string => {
  slugCounter.value++;
  return `test-event-${slugCounter.value}`;
};

/** Default test event input with slug */
export const testEventInput = (
  overrides: Partial<EventInput> = {},
): EventInput => ({
  slug: generateTestSlug(),
  name: "Test Event",
  description: "Test Description",
  maxAttendees: 100,
  thankYouUrl: "https://example.com/thanks",
  ...overrides,
});

/** Create a test event with sensible defaults */
export const createTestEvent = (overrides: Partial<EventInput> = {}) =>
  createEvent(testEventInput(overrides));

/** Re-export createEvent and EventInput for test use */
export { createEvent };
export type { EventInput };
