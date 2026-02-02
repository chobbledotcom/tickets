/**
 * Test utilities for the ticket reservation system
 */

import { type Client, createClient } from "@libsql/client";
import { clearEncryptionKeyCache } from "#lib/crypto.ts";
import { setDb } from "#lib/db/client.ts";
import {
  getEventWithCount,
  type EventInput,
} from "#lib/db/events.ts";
import { initDb, LATEST_UPDATE } from "#lib/db/migrations/index.ts";
import { getSession, resetSessionCache } from "#lib/db/sessions.ts";
import { clearSetupCompleteCache, completeSetup } from "#lib/db/settings.ts";
import type { Attendee, Event, EventWithCount } from "#lib/types.ts";

/**
 * Default test admin username
 */
export const TEST_ADMIN_USERNAME = "testadmin";

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
  Deno.env.set("TEST_SKIP_LOGIN_DELAY", "1"); // Skip timing-attack delay in tests
  Deno.env.set("TEST_RSA_KEY_SIZE", "1024"); // Use smaller RSA keys for faster test setup
  clearEncryptionKeyCache();
};

/**
 * Clear test encryption key from environment
 */
export const clearTestEncryptionKey = (): void => {
  Deno.env.delete("DB_ENCRYPTION_KEY");
  Deno.env.delete("TEST_PBKDF2_ITERATIONS");
  Deno.env.delete("TEST_SKIP_LOGIN_DELAY");
  Deno.env.delete("TEST_RSA_KEY_SIZE");
  clearEncryptionKeyCache();
};

// ---------------------------------------------------------------------------
// Cached test database infrastructure
// Avoids recreating the SQLite client, re-running migrations, and regenerating
// RSA keys + password hashes on every single test.
// ---------------------------------------------------------------------------

/** Cached in-memory SQLite client, reused across tests */
let cachedClient: Client | null = null;

/** Snapshot of settings rows after completeSetup (avoids re-running crypto) */
let cachedSetupSettings: Array<{ key: string; value: string }> | null = null;

/** Snapshot of users rows after completeSetup */
// deno-lint-ignore no-explicit-any
let cachedSetupUsers: Array<Record<string, any>> | null = null;

/** Cached admin session (avoids re-doing login + key wrapping per test) */
let cachedAdminSession: {
  cookie: string;
  csrfToken: string;
  sessionRow: { token: string; csrf_token: string; expires: number; wrapped_data_key: string | null; user_id: number | null };
} | null = null;

/** Clear all data tables and reset autoincrement counters */
const clearDataTables = async (
  client: Client,
): Promise<void> => {
  // Disable FK checks so deletion order doesn't matter
  await client.execute("PRAGMA foreign_keys = OFF");
  // Discover all user tables dynamically (handles custom test tables like test_items)
  const result = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  );
  for (const row of result.rows) {
    const name = row.name as string;
    await client.execute(`DELETE FROM ${name}`);
  }
  // Reset autoincrement counters so IDs start from 1 (table may not exist)
  await client.execute(
    "DELETE FROM sqlite_sequence WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_sequence')",
  );
  await client.execute("PRAGMA foreign_keys = ON");
};

/** Check if the cached client's schema is still intact */
const isSchemaIntact = async (client: Client): Promise<boolean> => {
  try {
    await client.execute("SELECT 1 FROM settings LIMIT 1");
    return true;
  } catch {
    return false;
  }
};

/** Common setup: env, caches, and reuse-or-create the client */
const prepareTestClient = async (): Promise<{ reused: boolean }> => {
  setupTestEncryptionKey();
  clearSetupCompleteCache();
  resetSessionCache();

  if (cachedClient && await isSchemaIntact(cachedClient)) {
    setDb(cachedClient);
    await clearDataTables(cachedClient);
    return { reused: true };
  }

  const client = createClient({ url: ":memory:" });
  cachedClient = client;
  setDb(client);
  await initDb();
  return { reused: false };
};

/**
 * Create an in-memory database for testing (without setup).
 * Reuses the cached client and schema when possible, clearing all data.
 */
export const createTestDb = async (): Promise<void> => {
  const { reused } = await prepareTestClient();
  if (reused) {
    await cachedClient!.execute({
      sql: "INSERT INTO settings (key, value) VALUES ('latest_db_update', ?)",
      args: [LATEST_UPDATE],
    });
  }
};

/**
 * Create an in-memory database with setup already completed.
 * On the first call, runs the full setup (migrations + crypto key generation).
 * On subsequent calls, restores the cached settings snapshot instead.
 */
export const createTestDbWithSetup = async (
  currency = "GBP",
): Promise<void> => {
  const { reused } = await prepareTestClient();

  if (reused && cachedSetupSettings) {
    for (const row of cachedSetupSettings) {
      await cachedClient!.execute({
        sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
        args: [row.key, row.value],
      });
    }
    // Restore users table
    if (cachedSetupUsers) {
      for (const row of cachedSetupUsers) {
        await cachedClient!.execute({
          sql: "INSERT INTO users (id, username_hash, username_index, password_hash, wrapped_data_key, admin_level, invite_code_hash, invite_expiry) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          args: [row.id, row.username_hash, row.username_index, row.password_hash, row.wrapped_data_key, row.admin_level, row.invite_code_hash, row.invite_expiry],
        });
      }
    }
    return;
  }

  await completeSetup(TEST_ADMIN_USERNAME, TEST_ADMIN_PASSWORD, currency);

  // Snapshot settings AND users for reuse
  const result = await cachedClient!.execute("SELECT key, value FROM settings");
  cachedSetupSettings = result.rows.map((r) => ({
    key: r.key as string,
    value: r.value as string,
  }));

  // Also snapshot users table
  const usersResult = await cachedClient!.execute("SELECT * FROM users");
  cachedSetupUsers = usersResult.rows.map((r) => ({ ...r }));

  // Perform one admin login and cache the session for reuse
  const session = await loginAsAdmin();
  const sessionsResult = await cachedClient!.execute(
    "SELECT token, csrf_token, expires, wrapped_data_key, user_id FROM sessions LIMIT 1",
  );
  if (sessionsResult.rows.length > 0) {
    const row = sessionsResult.rows[0]!;
    cachedAdminSession = {
      cookie: session.cookie,
      csrfToken: session.csrfToken,
      sessionRow: {
        token: row.token as string,
        csrf_token: row.csrf_token as string,
        expires: row.expires as number,
        wrapped_data_key: row.wrapped_data_key as string | null,
        user_id: row.user_id as number | null,
      },
    };
  }
  testSession = session;
};

/**
 * Reset the database connection and clear caches.
 * Does NOT destroy the cached client — it will be reused by the next test.
 */
export const resetDb = (): void => {
  setDb(null);
  clearSetupCompleteCache();
  resetSessionCache();
  resetTestSession();
};

/**
 * Invalidate the cached test database client.
 * Call this when a test intentionally destroys the schema (e.g. resetDatabase).
 */
export const invalidateTestDbCache = (): void => {
  cachedClient = null;
  cachedSetupSettings = null;
  cachedSetupUsers = null;
  cachedAdminSession = null;
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
  const { handleRequest } = await import("#routes");
  if (typeof tokenOrOptions === "object" && tokenOrOptions !== null) {
    return handleRequest(testRequest(path, null, tokenOrOptions));
  }
  return handleRequest(testRequest(path, tokenOrOptions));
};

/** Restorable mock — any object with a mockRestore method */
interface Restorable {
  mockRestore?: (() => void) | undefined;
}

/**
 * Run a test body with mocks that are automatically restored afterward.
 * Replaces the try/finally pattern for spy cleanup.
 *
 * @param setup - Returns a record of spies (or a single spy)
 * @param body - Test body receiving the spies
 * @param cleanup - Optional extra cleanup (e.g. resetStripeClient)
 *
 * @example
 * // Single spy
 * await withMocks(
 *   () => spyOn(api, "method").mockResolvedValue("ok"),
 *   async (mock) => {
 *     const result = await doThing();
 *     expect(mock).toHaveBeenCalled();
 *   },
 * );
 *
 * // Multiple spies
 * await withMocks(
 *   () => ({
 *     retrieve: spyOn(api, "retrieve").mockResolvedValue(session),
 *     refund: spyOn(api, "refund").mockResolvedValue({ id: "re_1" }),
 *   }),
 *   async ({ retrieve, refund }) => {
 *     expect(refund).toHaveBeenCalledWith("pi_123");
 *   },
 * );
 *
 * // With extra cleanup
 * await withMocks(
 *   () => spyOn(api, "method").mockResolvedValue("ok"),
 *   async (mock) => { ... },
 *   resetStripeClient,
 * );
 */
export const withMocks = async <T extends Restorable | Record<string, Restorable>>(
  setup: () => T,
  body: (mocks: T) => void | Promise<void>,
  cleanup?: () => void | Promise<void>,
): Promise<void> => {
  const mocks = setup();
  try {
    await body(mocks);
  } finally {
    if (typeof (mocks as Restorable).mockRestore === "function") {
      (mocks as Restorable).mockRestore!();
    } else {
      for (const mock of Object.values(mocks as Record<string, Restorable>)) {
        mock.mockRestore?.();
      }
    }
    await cleanup?.();
  }
};

/** Counter for generating unique test event names */
const nameCounter = { value: 0 };

/** Reset test name counter (call in beforeEach) */
export const resetTestSlugCounter = (): void => {
  nameCounter.value = 0;
};

/** Generate a unique test event name */
export const generateTestEventName = (): string => {
  nameCounter.value++;
  return `Test Event ${nameCounter.value}`;
};

/** Default test event input with name (slug auto-generated by REST API) */
export const testEventInput = (
  overrides: Partial<Omit<EventInput, "slugIndex" | "slug">> = {},
): Omit<EventInput, "slugIndex" | "slug"> => ({
  name: generateTestEventName(),
  maxAttendees: 100,
  thankYouUrl: "https://example.com/thanks",
  ...overrides,
});

/** Cached session for test event creation */
let testSession: { cookie: string; csrfToken: string } | null = null;

/**
 * Perform a fresh admin login and return the cookie and CSRF token.
 * Unlike getTestSession, this does NOT cache — each call creates a new session.
 * Use in tests that need an isolated authenticated session.
 */
export const loginAsAdmin = async (): Promise<{
  cookie: string;
  csrfToken: string;
}> => {
  const { handleRequest } = await import("#routes");
  const loginResponse = await handleRequest(
    mockFormRequest("/admin/login", { username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD }),
  );
  const cookie = loginResponse.headers.get("set-cookie") || "";
  const csrfToken = await getCsrfTokenFromCookie(cookie);

  if (!csrfToken) {
    throw new Error("Failed to get CSRF token for admin login");
  }

  return { cookie, csrfToken };
};

/** Get or create an authenticated session for test helpers (cached) */
const getTestSession = async (): Promise<{
  cookie: string;
  csrfToken: string;
}> => {
  if (testSession) return testSession;

  // Fast path: restore cached session directly into the DB
  if (cachedAdminSession && cachedClient) {
    const { getDb } = await import("#lib/db/client.ts");
    const { sessionRow } = cachedAdminSession;
    await getDb().execute({
      sql: "INSERT INTO sessions (token, csrf_token, expires, wrapped_data_key, user_id) VALUES (?, ?, ?, ?, ?)",
      args: [sessionRow.token, sessionRow.csrf_token, sessionRow.expires, sessionRow.wrapped_data_key, sessionRow.user_id],
    });
    testSession = { cookie: cachedAdminSession.cookie, csrfToken: cachedAdminSession.csrfToken };
    return testSession;
  }

  testSession = await loginAsAdmin();
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
  const { handleRequest } = await import("#routes");

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
 * This is the preferred way to create test events as it exercises production code.
 * Slugs are auto-generated, so we look up the event by querying the latest one.
 */
export const createTestEvent = (
  overrides: Partial<Omit<EventInput, "slug" | "slugIndex">> = {},
): Promise<Event> => {
  const input = testEventInput(overrides);

  return authenticatedFormRequest(
    "/admin/event",
    {
      name: input.name,
      description: input.description ?? "",
      max_attendees: String(input.maxAttendees),
      max_quantity: String(input.maxQuantity ?? 1),
      fields: input.fields ?? "email",
      thank_you_url: input.thankYouUrl ?? "",
      unit_price: input.unitPrice != null ? String(input.unitPrice) : "",
      webhook_url: input.webhookUrl ?? "",
      closes_at: input.closesAt ?? "",
    },
    async () => {
      // Get the most recently created event
      const { getAllEvents } = await import("#lib/db/events.ts");
      const events = await getAllEvents();
      const event = events[0]; // getAllEvents returns DESC by created
      if (!event) {
        throw new Error(`Event not found after creation: ${input.name}`);
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

/** Format closes_at for form submission (truncate existing ISO to datetime-local) */
const formatClosesAt = (
  update: string | undefined,
  existing: string | null,
): string =>
  update !== undefined ? update : (existing?.slice(0, 16) ?? "");

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
      name: updates.name ?? existing.name,
      description: updates.description ?? existing.description,
      slug: updates.slug ?? existing.slug,
      max_attendees: String(updates.maxAttendees ?? existing.max_attendees),
      max_quantity: String(updates.maxQuantity ?? existing.max_quantity),
      fields: updates.fields ?? existing.fields,
      thank_you_url: formatOptional(updates.thankYouUrl, existing.thank_you_url),
      unit_price: formatPrice(updates.unitPrice, existing.unit_price),
      webhook_url: formatOptional(updates.webhookUrl, existing.webhook_url),
      closes_at: formatClosesAt(updates.closesAt, existing.closes_at),
    },
    async () =>
      (await getEventWithCount(eventId)) as EventWithCount,
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
      { confirm_identifier: event.name },
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
  phone = "",
): Promise<Attendee> => {
  const { handleRequest } = await import("#routes");

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
    mockTicketFormRequest(eventSlug, { name, email, phone, quantity: String(quantity) }, csrfToken),
  );

  // Free events redirect to thank you page (302)
  // Paid events redirect to Stripe (303)
  if (response.status !== 302 && response.status !== 303) {
    const body = await response.text();
    throw new Error(
      `Failed to create attendee: ${response.status} - ${body.slice(0, 200)}`,
    );
  }

  // Return the most recent attendee (DESC order puts newest first)
  const afterAttendees = await getAttendeesRaw(eventId);
  return afterAttendees[0] as Attendee;
};

/**
 * Re-export getAttendeesRaw for verifying encrypted data in tests
 * This is used in production by getAttendees, so not a test-only export
 */
export { getAttendeesRaw };

// ---------------------------------------------------------------------------
// FP-style curried assertion helpers
// These are data-last / pipe-compatible helpers for common test assertions.
// Import `expect` lazily so the module can be loaded outside test contexts.
// ---------------------------------------------------------------------------

import { expect } from "#test-compat";

/** Assert a Response has the given status code. Returns the response for chaining. */
export const expectStatus =
  (status: number) =>
  (response: Response): Response => {
    expect(response.status).toBe(status);
    return response;
  };

/** Assert a Response is a redirect (302) to the given location. */
export const expectRedirect =
  (location: string) =>
  (response: Response): Response => {
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(location);
    return response;
  };

/** Shorthand: assert redirect to /admin */
export const expectAdminRedirect: (response: Response) => Response =
  expectRedirect("/admin");

/** Assert a result object has ok:false with the expected error string. */
export const expectResultError =
  (expectedError: string) =>
  <T extends { ok: boolean; error?: string }>(result: T): T => {
    expect(result.ok).toBe(false);
    if (!result.ok && "error" in result) {
      expect(result.error).toBe(expectedError);
    }
    return result;
  };

/** Assert a result object has ok:false and notFound:true. */
export const expectResultNotFound = <
  T extends { ok: boolean; notFound?: boolean },
>(
  result: T,
): T => {
  expect(result.ok).toBe(false);
  expect("notFound" in result && result.notFound).toBe(true);
  return result;
};

/** Response factory: creates a callback returning a Response with given status/body. */
export const successResponse =
  (status: number, body?: string) => (): Response =>
    new Response(body ?? null, { status });

/** Error response factory: creates a callback taking an error string. */
export const errorResponse =
  (status: number) =>
  (error: string): Response =>
    new Response(error, { status });

// ---------------------------------------------------------------------------
// Test data factories
// Partial-override factories for common domain objects.
// Pass only the fields you care about; everything else gets sensible defaults.
// ---------------------------------------------------------------------------

/** Create a test Event with sensible defaults. Override any field via `overrides`. */
export const testEvent = (overrides: Partial<Event> = {}): Event => ({
  id: 1,
  name: "Test Event",
  description: "",
  slug: "ab12c",
  slug_index: "test-event-index",
  max_attendees: 100,
  thank_you_url: "https://example.com/thanks",
  created: "2024-01-01T00:00:00Z",
  unit_price: null,
  max_quantity: 1,
  webhook_url: null,
  closes_at: null,
  active: 1,
  fields: "email",
  ...overrides,
});

/** Create a test EventWithCount (Event + attendee_count). */
export const testEventWithCount = (
  overrides: Partial<EventWithCount> = {},
): EventWithCount => ({
  ...testEvent(overrides),
  attendee_count: 0,
  ...overrides,
});

/** Create a test Attendee with sensible defaults. */
export const testAttendee = (overrides: Partial<Attendee> = {}): Attendee => ({
  id: 1,
  event_id: 1,
  name: "John Doe",
  email: "john@example.com",
  phone: "",
  created: "2024-01-01T12:00:00Z",
  payment_id: null,
  quantity: 1,
  price_paid: null,
  checked_in: "false",
  ticket_token: "test-token-1",
  ...overrides,
});

// ---------------------------------------------------------------------------
// Form validation helpers
// Curried helpers for the common validate-then-assert pattern in form tests.
// ---------------------------------------------------------------------------

import { type Field, validateForm } from "#lib/forms.tsx";

/** Validate form data and return the result. Shared core for assertion helpers. */
const validateFormData = (fields: Field[], data: Record<string, string>) =>
  validateForm(new URLSearchParams(data), fields);

/** Validate form data against fields and assert the result is valid. Returns the values. */
export const expectValid = (
  fields: Field[],
  data: Record<string, string>,
): Record<string, unknown> => {
  const result = validateFormData(fields, data);
  expect(result.valid).toBe(true);
  return (result as { valid: true; values: Record<string, unknown> }).values;
};

/** Validate form data against fields and assert the result is invalid with given error. */
export const expectInvalid =
  (expectedError: string) =>
  (fields: Field[], data: Record<string, string>): void => {
    const result = validateFormData(fields, data);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toBe(expectedError);
  };

/** Validate form data against fields and assert the result is invalid (any error). */
export const expectInvalidForm = (
  fields: Field[],
  data: Record<string, string>,
): void => {
  expect(validateFormData(fields, data).valid).toBe(false);
};

/**
 * Submit a ticket form with automatic CSRF token handling.
 * GETs the ticket page first to obtain a CSRF token, then POSTs the form.
 */
export const submitTicketForm = async (
  slug: string,
  data: Record<string, string>,
): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  const getResponse = await handleRequest(mockRequest(`/ticket/${slug}`));
  const csrfToken = getTicketCsrfToken(getResponse.headers.get("set-cookie"));
  if (!csrfToken) throw new Error("Failed to get CSRF token from ticket page");
  return handleRequest(mockTicketFormRequest(slug, data, csrfToken));
};

/**
 * Configure Stripe as the payment provider for tests.
 */
export const setupStripe = async (key = "sk_test_mock"): Promise<void> => {
  const { updateStripeKey, setPaymentProvider } = await import(
    "#lib/db/settings.ts"
  );
  await updateStripeKey(key);
  await setPaymentProvider("stripe");
};

/**
 * Create a mock webhook POST request.
 */
export const mockWebhookRequest = (
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request =>
  new Request("http://localhost/payment/webhook", {
    method: "POST",
    headers: {
      host: "localhost",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });

/** Base event form data — merge with overrides for specific test cases. */
export const baseEventForm: Record<string, string> = {
  name: "My Event",
  max_attendees: "100",
  max_quantity: "1",
  thank_you_url: "https://example.com",
};

