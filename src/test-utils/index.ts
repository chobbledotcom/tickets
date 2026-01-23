/**
 * Test utilities for the ticket reservation system
 */

import { createClient } from "@libsql/client";
import { clearEncryptionKeyCache } from "../lib/crypto.ts";
import { createEvent } from "../lib/db/events.ts";
import {
  completeSetup,
  type EventInput,
  getSession,
  initDb,
  setDb,
} from "../lib/db/index.ts";

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
 * Also enables fast scrypt hashing for tests
 */
export const setupTestEncryptionKey = (): void => {
  process.env.DB_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  process.env.TEST_SCRYPT_N = "1"; // Enable fast password hashing for tests
  clearEncryptionKeyCache();
};

/**
 * Clear test encryption key from environment
 */
export const clearTestEncryptionKey = (): void => {
  delete process.env.DB_ENCRYPTION_KEY;
  delete process.env.TEST_SCRYPT_N;
  clearEncryptionKeyCache();
};

/**
 * Create an in-memory database for testing
 * Also sets up the test encryption key
 */
export const createTestDb = async (): Promise<void> => {
  setupTestEncryptionKey();
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
  stripeKey: string | null = null,
  currency = "GBP",
): Promise<void> => {
  await createTestDb();
  await completeSetup(TEST_ADMIN_PASSWORD, stripeKey, currency);
};

/**
 * Reset the database connection
 */
export const resetDb = (): void => {
  setDb(null);
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
  const sessionMatch = cookie.match(/session=([^;]+)/);
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
    "/setup/",
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
  eventId: number,
  data: Record<string, string>,
  csrfToken: string,
): Request => {
  return mockFormRequest(
    `/ticket/${eventId}`,
    { ...data, csrf_token: csrfToken },
    `csrf_token=${csrfToken}`,
  );
};

/** Re-export createEvent and EventInput for test use */
export { createEvent };
export type { EventInput };
