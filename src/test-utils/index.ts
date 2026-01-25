/**
 * Test utilities for the ticket reservation system
 */

import { createClient } from "@libsql/client";
import { clearEncryptionKeyCache } from "#lib/crypto.ts";
import { setDb } from "#lib/db/client.ts";
import {
  getEventWithCount,
  getEventWithCountBySlug,
  type EventInput,
} from "#lib/db/events.ts";
import { initDb } from "#lib/db/migrations/index.ts";
import { getSession, resetSessionCache } from "#lib/db/sessions.ts";
import { clearSetupCompleteCache, completeSetup } from "#lib/db/settings.ts";
import type { Event } from "#lib/types.ts";

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
  resetTestSession();
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
 * Automatically includes accept_agreement: "yes" unless explicitly overridden
 */
export const mockSetupFormRequest = (
  data: Record<string, string>,
  csrfToken: string,
): Request => {
  return mockFormRequest(
    "/setup",
    { accept_agreement: "yes", ...data, csrf_token: csrfToken },
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

/** Default test event input with slug (slugIndex computed by REST API) */
export const testEventInput = (
  overrides: Partial<Omit<EventInput, "slugIndex">> = {},
): Omit<EventInput, "slugIndex"> => ({
  slug: generateTestSlug(),
  name: "Test Event",
  description: "Test Description",
  maxAttendees: 100,
  thankYouUrl: "https://example.com/thanks",
  ...overrides,
});

/** Cached session for test event creation */
let testSession: { cookie: string; csrfToken: string } | null = null;

/** Get or create an authenticated session for test helpers */
const getTestSession = async (): Promise<{
  cookie: string;
  csrfToken: string;
}> => {
  if (testSession) return testSession;

  const { handleRequest } = await import("#src/server.ts");
  const loginResponse = await handleRequest(
    mockFormRequest("/admin/login", { password: TEST_ADMIN_PASSWORD }),
  );
  const cookie = loginResponse.headers.get("set-cookie") || "";
  const csrfToken = await getCsrfTokenFromCookie(cookie);

  if (!csrfToken) {
    throw new Error("Failed to get CSRF token for test session");
  }

  testSession = { cookie, csrfToken };
  return testSession;
};

/** Clear cached test session (call in beforeEach with resetDb) */
export const resetTestSession = (): void => {
  testSession = null;
};

/**
 * Execute an authenticated form request expecting a redirect.
 * Handles session management, CSRF tokens, and status validation.
 */
const authenticatedFormRequest = async <T>(
  path: string,
  formData: Record<string, string>,
  onSuccess: () => Promise<T>,
  errorContext: string,
): Promise<T> => {
  const session = await getTestSession();
  const { handleRequest } = await import("#src/server.ts");

  const response = await handleRequest(
    mockFormRequest(path, { ...formData, csrf_token: session.csrfToken }, session.cookie),
  );

  if (response.status !== 302) {
    throw new Error(`Failed to ${errorContext}: ${response.status}`);
  }

  return onSuccess();
};

/**
 * Create an event via the REST API
 * This is the preferred way to create test events as it exercises production code
 */
export const createTestEvent = (
  overrides: Partial<EventInput> = {},
): Promise<Event> => {
  const input = testEventInput(overrides);

  return authenticatedFormRequest(
    "/admin/event",
    {
      slug: input.slug,
      name: input.name,
      description: input.description,
      max_attendees: String(input.maxAttendees),
      max_quantity: String(input.maxQuantity ?? 1),
      thank_you_url: input.thankYouUrl ?? "",
      unit_price: input.unitPrice != null ? String(input.unitPrice) : "",
      webhook_url: input.webhookUrl ?? "",
    },
    async () => {
      const event = await getEventWithCountBySlug(input.slug);
      if (!event) {
        throw new Error(`Event not found after creation: ${input.slug}`);
      }
      return event;
    },
    "create event",
  );
};

/** Format optional price field for form submission */
const formatPrice = (
  update: number | null | undefined,
  existing: number | null,
): string =>
  update !== undefined
    ? update != null
      ? String(update)
      : ""
    : existing != null
      ? String(existing)
      : "";

/** Format optional nullable string field for form submission */
const formatOptional = (
  update: string | null | undefined,
  existing: string | null,
): string =>
  update !== undefined ? update ?? "" : existing ?? "";

/**
 * Update an event via the REST API
 */
export const updateTestEvent = async (
  eventId: number,
  updates: Partial<EventInput>,
): Promise<Event> => {
  const existing = await getEventWithCount(eventId);
  if (!existing) {
    throw new Error(`Event not found: ${eventId}`);
  }

  return authenticatedFormRequest(
    `/admin/event/${eventId}/edit`,
    {
      slug: updates.slug ?? existing.slug,
      name: updates.name ?? existing.name,
      description: updates.description ?? existing.description,
      max_attendees: String(updates.maxAttendees ?? existing.max_attendees),
      max_quantity: String(updates.maxQuantity ?? existing.max_quantity),
      thank_you_url: formatOptional(updates.thankYouUrl, existing.thank_you_url),
      unit_price: formatPrice(updates.unitPrice, existing.unit_price),
      webhook_url: formatOptional(updates.webhookUrl, existing.webhook_url),
    },
    async () => {
      const updated = await getEventWithCount(eventId);
      if (!updated) {
        throw new Error(`Event not found after update: ${eventId}`);
      }
      return updated;
    },
    "update event",
  );
};

/**
 * Change event active status via the REST API
 */
const changeEventStatus =
  (action: "deactivate" | "reactivate") =>
  async (eventId: number): Promise<void> => {
    const event = await getEventWithCount(eventId);
    if (!event) {
      throw new Error(`Event not found: ${eventId}`);
    }

    return authenticatedFormRequest(
      `/admin/event/${eventId}/${action}`,
      { confirm_name: event.name },
      async () => {},
      `${action} event`,
    );
  };

/**
 * Deactivate an event via the REST API
 */
export const deactivateTestEvent = changeEventStatus("deactivate");

/**
 * Reactivate an event via the REST API
 */
export const reactivateTestEvent = changeEventStatus("reactivate");

export type { EventInput };

import type { Attendee } from "#lib/types.ts";
import { getAttendeesRaw } from "#lib/db/attendees.ts";

/**
 * Create an attendee via the public ticket form
 * This exercises the same code path as production (createAttendeeAtomic)
 * Returns the created attendee (with encrypted fields - use for ID only)
 */
export const createTestAttendee = async (
  eventId: number,
  eventSlug: string,
  name: string,
  email: string,
  quantity = 1,
): Promise<Attendee> => {
  const { handleRequest } = await import("#src/server.ts");

  // Get count before to find the new attendee
  const beforeAttendees = await getAttendeesRaw(eventId);
  const beforeCount = beforeAttendees.length;

  // Get the ticket page to get a CSRF token
  const pageResponse = await handleRequest(mockRequest(`/ticket/${eventSlug}`));
  const csrfToken = getTicketCsrfToken(
    pageResponse.headers.get("set-cookie"),
  );

  if (!csrfToken) {
    throw new Error("Failed to get CSRF token for ticket form");
  }

  // Submit the ticket form
  const response = await handleRequest(
    mockTicketFormRequest(eventSlug, { name, email, quantity: String(quantity) }, csrfToken),
  );

  // Free events redirect to thank you page (302)
  // Paid events redirect to Stripe (303)
  if (response.status !== 302 && response.status !== 303) {
    const body = await response.text();
    throw new Error(
      `Failed to create attendee: ${response.status} - ${body.slice(0, 200)}`,
    );
  }

  // Get the created attendee (most recent one)
  const afterAttendees = await getAttendeesRaw(eventId);
  if (afterAttendees.length <= beforeCount) {
    throw new Error("Attendee was not created");
  }

  // Return the first attendee (most recent due to DESC order)
  return afterAttendees[0] as Attendee;
};

/**
 * Re-export getAttendeesRaw for verifying encrypted data in tests
 * This is used in production by getAttendees, so not a test-only export
 */
export { getAttendeesRaw };

