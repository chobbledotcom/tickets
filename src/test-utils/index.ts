/**
 * Test utilities for the ticket reservation system
 */

import {
  type Client,
  createClient,
  type InValue,
  type Row,
} from "@libsql/client";
import { afterEach, beforeEach, describe } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import forge from "node-forge";
import { bracket } from "#fp";
import type { SigningCredentials } from "#lib/apple-wallet.ts";
import { bunnyCdnApi } from "#lib/bunny-cdn.ts";
import { resetEffectiveDomain } from "#lib/config.ts";
import { getSessionCookieName, parseFlashValue } from "#lib/cookies.ts";
import { setEncryptionKeyForTest } from "#lib/crypto/encryption.ts";
import { setFastPbkdf2ForTest } from "#lib/crypto/hashing.ts";
import { setRsaKeySizeForTest, unwrapKeyWithToken } from "#lib/crypto/keys.ts";
import { generateSecureToken } from "#lib/crypto/utils.ts";
import { signCsrfToken } from "#lib/csrf.ts";
import { toMajorUnits } from "#lib/currency.ts";
import { createApiKey } from "#lib/db/api-keys.ts";
import { getDb, setDb } from "#lib/db/client.ts";
import {
  type EventInput,
  getEventWithCount,
  invalidateEventsCache,
} from "#lib/db/events.ts";
import { type GroupInput, invalidateGroupsCache } from "#lib/db/groups.ts";
import { invalidateHolidaysCache } from "#lib/db/holidays.ts";
import { initDb } from "#lib/db/migrations.ts";
import { getSession, resetSessionCache } from "#lib/db/sessions.ts";
import { settings } from "#lib/db/settings.ts";
import { invalidateUsersCache } from "#lib/db/users.ts";
import { setDemoModeForTest } from "#lib/demo.ts";
import { resetHostEmailConfig, setHostEmailConfigForTest } from "#lib/email.ts";
import { FormParams } from "#lib/form-data.ts";
import type { GoogleWalletCredentials } from "#lib/google-wallet.ts";
import { setSuppressRequestLogs } from "#lib/logger.ts";
import { runWithStorageConfig } from "#lib/storage.ts";
import type { Attendee, Event, EventWithCount, Group } from "#lib/types.ts";
import { setSkipLoginDelayForTest } from "#routes/admin/auth.ts";
import { setRethrowErrorsForTest } from "#routes/index.ts";

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
  setEncryptionKeyForTest(TEST_ENCRYPTION_KEY); // Also clears all crypto caches via callbacks
  setFastPbkdf2ForTest(true); // Module-level override avoids env race in parallel tests
  setSkipLoginDelayForTest(true);
  setRsaKeySizeForTest(1024);
  setSuppressRequestLogs(true);
  setRethrowErrorsForTest(true);
};

/**
 * Clear test encryption key from environment
 */
export const clearTestEncryptionKey = (): void => {
  // Use empty string (not null) so the override stays active and doesn't
  // fall through to Deno.env, avoiding races with parallel test workers.
  setEncryptionKeyForTest("");
  setFastPbkdf2ForTest(null);
  setSkipLoginDelayForTest(false);
  setRsaKeySizeForTest(null);
  setSuppressRequestLogs(null);
  setRethrowErrorsForTest(null);
};

// ---------------------------------------------------------------------------
// Cached test database infrastructure
// Avoids recreating the SQLite client, re-running migrations, and regenerating
// RSA keys + password hashes on every single test.
// ---------------------------------------------------------------------------

/** Get the current test DB client (set via setDb in prepareTestClient). */
const getClient = (): Client => getDb();

/** Snapshot of settings rows after completeSetup (avoids re-running crypto) */
let cachedSetupSettings: Array<{ key: string; value: string }> | null = null;

/** Snapshot of users rows after completeSetup */
let cachedSetupUsers: Row[] | null = null;

/** Cached admin session (avoids re-doing login + key wrapping per test) */
let cachedAdminSession: {
  cookie: string;
  sessionRow: {
    token: string;
    csrf_token: string;
    expires: number;
    wrapped_data_key: string | null;
    user_id: number | null;
  };
} | null = null;

/** Common setup: env, caches, and create a fresh in-memory client per test. */
const prepareTestClient = async (): Promise<void> => {
  setupTestEncryptionKey();
  settings.setup.clearCache();
  resetSessionCache();
  invalidateUsersCache();
  invalidateEventsCache();
  invalidateHolidaysCache();
  invalidateGroupsCache();

  const client = createClient({ url: ":memory:" });
  setDb(client);
  await initDb();
};

/**
 * Create an in-memory database for testing (without setup).
 * Creates a fresh in-memory client per test to avoid cross-test interference.
 */
export const createTestDb = async (): Promise<void> => {
  await prepareTestClient();
  resetTestSession();
};

/**
 * Create an in-memory database with setup already completed.
 * On the first call, runs the full setup (migrations + crypto key generation)
 * and caches the resulting rows. Subsequent calls restore the cached snapshot
 * into a fresh in-memory DB to skip expensive crypto operations.
 */
export const createTestDbWithSetup = async (country = "GB"): Promise<void> => {
  await prepareTestClient();
  resetTestSession();

  if (cachedSetupSettings) {
    // Clear any rows initDb() may have inserted to avoid UNIQUE conflicts
    await getClient().execute("DELETE FROM settings");
    for (const row of cachedSetupSettings) {
      await getClient().execute({
        sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
        args: [row.key, row.value],
      });
    }
    if (cachedSetupUsers) {
      for (const row of cachedSetupUsers) {
        await getClient().execute({
          sql: "INSERT INTO users (id, username_hash, username_index, password_hash, wrapped_data_key, admin_level, invite_code_hash, invite_expiry) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          args: [
            row.id as InValue,
            row.username_hash as InValue,
            row.username_index as InValue,
            row.password_hash as InValue,
            row.wrapped_data_key as InValue,
            row.admin_level as InValue,
            row.invite_code_hash as InValue,
            row.invite_expiry as InValue,
          ],
        });
      }
    }
    settings.invalidateCache();
    await settings.loadAll();

    settings.setForTest({ timezone: "UTC" });
    return;
  }

  await settings.setup.complete(
    TEST_ADMIN_USERNAME,
    TEST_ADMIN_PASSWORD,
    country,
  );
  await settings.loadAll();

  // Default timezone to UTC for tests so datetime-local values pass through unchanged
  settings.setForTest({ timezone: "UTC" });

  // Snapshot settings AND users for reuse
  const result = await getClient().execute("SELECT key, value FROM settings");
  cachedSetupSettings = result.rows.map((r) => ({
    key: r.key as string,
    value: r.value as string,
  }));

  const usersResult = await getClient().execute("SELECT * FROM users");
  cachedSetupUsers = usersResult.rows.map((r) => ({ ...r }));

  // Create admin session directly (bypasses handleRequest pipeline whose
  // isSetupComplete() check can fail under parallel test execution when
  // another worker invalidates the shared settings cache singleton).
  const session = await createDirectAdminSession();
  const sessionsResult = await getClient().execute(
    "SELECT token, csrf_token, expires, wrapped_data_key, user_id FROM sessions LIMIT 1",
  );
  if (sessionsResult.rows.length > 0) {
    const row = sessionsResult.rows[0] as Row;
    cachedAdminSession = {
      cookie: session.cookie,
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
 */
export const resetDb = (): void => {
  setDb(null);
  settings.setup.clearCache();
  settings.invalidateCache();
  invalidateUsersCache();
  invalidateEventsCache();
  invalidateHolidaysCache();
  invalidateGroupsCache();
  resetSessionCache();
  resetTestSession();
  setDemoModeForTest(false);
  resetEffectiveDomain();
  resetHostEmailConfig();
  settings.appleWallet.resetHostConfig();
  settings.googleWallet.resetHostConfig();
  settings.clearTestOverrides();
};

/**
 * Invalidate the cached test database snapshots.
 * Call this when a test intentionally destroys the schema (e.g. resetDatabase).
 */
export const invalidateTestDbCache = (): void => {
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
 * Create a mock admin login POST request with signed CSRF token
 */
export const mockAdminLoginRequest = async (
  data: Record<string, string>,
  csrfToken?: string,
): Promise<Request> => {
  const token = csrfToken ?? (await signCsrfToken());
  return mockFormRequest("/admin/login", { ...data, csrf_token: token });
};

/**
 * Create a mock multipart POST request with optional file upload.
 * Text fields are added as form entries, and an optional file is appended.
 */
export const mockMultipartRequest = (
  path: string,
  data: Record<string, string>,
  cookie?: string,
  file?: {
    name: string;
    fieldName: string;
    data: Uint8Array;
    contentType: string;
  },
): Request => {
  const formData = new FormData();
  for (const [key, value] of Object.entries(data)) {
    formData.append(key, value);
  }
  if (file) {
    // deno-lint-ignore no-explicit-any
    const blob = new Blob([file.data as any], { type: file.contentType });
    formData.append(file.fieldName, blob, file.name);
  }
  const headers: HeadersInit = { host: "localhost" };
  if (cookie) headers.cookie = cookie;
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: formData,
  });
};

/**
 * Extract URL string from a fetch input parameter (Request, URL, or string).
 * Useful in fetch mocks to inspect the requested URL regardless of input type.
 */
export const urlFromFetchInput = (input: string | URL | Request): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;

/**
 * Run a callback that intentionally triggers an error caught by handleRequest.
 * Temporarily sets TEST_EXPECT_ERROR so the error is returned as a response
 * instead of being rethrown by the TEST_RETHROW_ERRORS guard.
 */
export const withExpectedError = bracket(
  () => {
    Deno.env.set("TEST_EXPECT_ERROR", "1");
  },
  () => {
    Deno.env.delete("TEST_EXPECT_ERROR");
  },
);

/**
 * Swap globalThis.fetch for the duration of a callback, using bracket for safe restore.
 * The original fetch is passed to the callback so it can be used as a fallback.
 *
 * @example
 * await withFetchMock(async (originalFetch) => {
 *   globalThis.fetch = () => Promise.resolve(new Response("mocked"));
 *   const res = await handleRequest(mockRequest("/api"));
 *   expect(res.status).toBe(200);
 * });
 */
export const withFetchMock = bracket(
  () => globalThis.fetch,
  (original) => {
    globalThis.fetch = original;
  },
);

/**
 * Install a URL-based fetch handler on globalThis.fetch.
 * For each request, calls `handler(url, init)`. If the handler returns null,
 * the call falls through to the provided `fallback` fetch.
 *
 * @example
 * installUrlHandler(originalFetch, (url) =>
 *   url.includes("cdn.example.com") ? Promise.resolve(new Response("ok")) : null,
 * );
 */
export const installUrlHandler = (
  fallback: typeof globalThis.fetch,
  handler: (url: string, init?: RequestInit) => Promise<Response> | null,
): void => {
  globalThis.fetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = urlFromFetchInput(input);
    return handler(url, init) ?? fallback(input, init);
  };
};

// ---------------------------------------------------------------------------
// Per-worker Deno.env overlay for test isolation.
// Intercepts Deno.env.get/set/delete so that env vars set during a test stay
// local to this worker and never leak to parallel workers via the real env.
// When no overlay is active, Deno.env behaves normally.
// ---------------------------------------------------------------------------
const _realGet = Deno.env.get.bind(Deno.env);
const _realSet = Deno.env.set.bind(Deno.env);
const _realDelete = Deno.env.delete.bind(Deno.env);

/** Keys currently managed by an active setTestEnv scope. */
let _overlay: Record<string, string | undefined> | null = null;

Deno.env.get = (key: string): string | undefined =>
  _overlay && key in _overlay ? _overlay[key] : _realGet(key);

Deno.env.set = (key: string, value: string): void => {
  if (_overlay && key in _overlay) _overlay[key] = value;
  else _realSet(key, value);
};

Deno.env.delete = (key: string): void => {
  if (_overlay && key in _overlay) _overlay[key] = undefined;
  else _realDelete(key);
};

/**
 * Set env vars for a test and return a restore function that puts them back.
 * Uses a per-worker overlay on Deno.env so parallel test workers cannot leak
 * env vars to each other. All Deno.env.get/set/delete calls within the scope
 * are transparently intercepted for the managed keys.
 * Pass `undefined` as a value to delete the key (useful for ensuring a clean slate).
 *
 * @example
 * let restoreEnv: () => void;
 * beforeEach(() => { restoreEnv = setTestEnv({ STORAGE_ZONE_NAME: "z", STORAGE_ZONE_KEY: "k" }); });
 * afterEach(() => restoreEnv());
 *
 * // Delete keys to start with a clean slate:
 * restoreEnv = setTestEnv({ BUNNY_API_KEY: undefined });
 */
export const setTestEnv = (
  vars: Record<string, string | undefined>,
): (() => void) => {
  const prev = _overlay;
  const layer: Record<string, string | undefined> = prev
    ? { ...prev }
    : Object.create(null);
  for (const key of Object.keys(vars)) {
    // Save the real env value only the first time this key enters the overlay
    if (!(key in layer)) layer[key] = _realGet(key);
  }
  _overlay = layer;
  // Apply the requested values through the intercepted Deno.env so they
  // land in the overlay (not the real env).
  for (const key of Object.keys(vars)) {
    const value = vars[key];
    if (value !== undefined) Deno.env.set(key, value);
    else Deno.env.delete(key);
  }
  return () => {
    _overlay = prev;
  };
};

/** Options for {@link describeWithEnv}. */
interface DescribeEnvOptions {
  /** Environment variables to set before each test and restore after. */
  env?: Record<string, string | undefined>;
  /** Reset slug counter, create test DB in beforeEach; resetDb in afterEach. */
  db?: boolean;
  /** Call setupTestEncryptionKey in beforeEach. */
  encryptionKey?: boolean;
}

/**
 * Describe block with automatic test infrastructure setup.
 * Additional beforeEach/afterEach hooks can be added inside the callback.
 *
 * @example
 * describeWithEnv("storage", { env: { STORAGE_ZONE_NAME: "z" }, db: true }, () => {
 *   test("uses storage", () => { ... });
 * });
 */
export const describeWithEnv = (
  name: string,
  options: DescribeEnvOptions,
  fn: () => void,
): void => {
  describe(name, () => {
    let restoreEnv: () => void;
    beforeEach(async () => {
      if (options.encryptionKey) setupTestEncryptionKey();
      if (options.db) {
        resetTestSlugCounter();
        setHostEmailConfigForTest(null);
        settings.appleWallet.setHostConfigForTest(null);
        settings.googleWallet.setHostConfigForTest(null);
        await createTestDbWithSetup();
      }
      if (options.env) restoreEnv = setTestEnv(options.env);
    });
    afterEach(() => {
      if (options.db) resetDb();
      if (options.env) restoreEnv();
    });
    fn();
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
  const sessionMatch = cookie.match(
    new RegExp(`${getSessionCookieName()}=([^;]+)`),
  );
  if (!sessionMatch?.[1]) return null;

  const sessionToken = sessionMatch[1];
  const session = await getSession(sessionToken);
  return session?.csrf_token ?? null;
};

/**
 * Extract CSRF token from an HTML page's hidden form field
 */
export const extractCsrfToken = (html: string | null): string | null => {
  if (!html) return null;
  const match = html.match(/name="csrf_token"\s+value="([^"]+)"/);
  return match?.[1] ?? null;
};

/**
 * Extract admin login CSRF token from HTML body
 */
export const getAdminLoginCsrfToken = (html: string | null): string | null =>
  extractCsrfToken(html);

/**
 * Extract join CSRF token from HTML body
 */
export const getJoinCsrfToken = (html: string | null): string | null =>
  extractCsrfToken(html);

/**
 * Extract join CSRF token from HTML body, throwing if missing
 */
export const requireJoinCsrfToken = (html: string | null): string => {
  const token = extractCsrfToken(html);
  if (!token) throw new Error("Failed to get CSRF token for join flow");
  return token;
};

/**
 * Extract setup CSRF token from HTML body
 */
export const getSetupCsrfToken = (html: string | null): string | null =>
  extractCsrfToken(html);

/**
 * Create a mock setup POST request with CSRF token
 * Automatically includes accept_agreement: "yes" unless explicitly overridden
 */
export const mockSetupFormRequest = (
  data: Record<string, string>,
  csrfToken: string,
): Request => {
  return mockFormRequest("/setup", {
    accept_agreement: "yes",
    ...data,
    csrf_token: csrfToken,
  });
};

/**
 * Extract ticket CSRF token from HTML body
 */
export const getTicketCsrfToken = (html: string | null): string | null =>
  extractCsrfToken(html);

/**
 * Create a mock ticket form POST request with CSRF token
 */
export const mockTicketFormRequest = (
  slug: string,
  data: Record<string, string>,
  csrfToken: string,
): Request => {
  return mockFormRequest(`/ticket/${slug}`, { ...data, csrf_token: csrfToken });
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
    headers.cookie = `${getSessionCookieName()}=${token}`;
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

/** Restorable mock — any object with a restore method (Deno @std/testing/mock) */
interface Restorable {
  restore?: (() => void) | undefined;
}

/**
 * Run a test body with stubs that are automatically restored afterward.
 * Replaces the try/finally pattern for stub cleanup.
 *
 * @param setup - Returns a record of stubs (or a single stub)
 * @param body - Test body receiving the stubs
 * @param cleanup - Optional extra cleanup (e.g. resetStripeClient)
 *
 * @example
 * // Single stub
 * await withMocks(
 *   () => stub(api, "method", () => Promise.resolve("ok")),
 *   async (mock) => {
 *     const result = await doThing();
 *     expect(mock.calls.length).toBeGreaterThan(0);
 *   },
 * );
 *
 * // Multiple stubs
 * await withMocks(
 *   () => ({
 *     retrieve: stub(api, "retrieve", () => Promise.resolve(session)),
 *     refund: stub(api, "refund", () => Promise.resolve({ id: "re_1" })),
 *   }),
 *   async ({ refund }) => {
 *     expect(refund.calls[0].args).toEqual(["pi_123"]);
 *   },
 * );
 *
 * // With extra cleanup
 * await withMocks(
 *   () => stub(api, "method", () => Promise.resolve("ok")),
 *   async (mock) => { ... },
 *   resetStripeClient,
 * );
 */
export const withMocks = async <
  T extends Restorable | Record<string, Restorable>,
>(
  setup: () => T,
  body: (mocks: T) => void | Promise<void>,
  cleanup?: () => void | Promise<void>,
): Promise<void> => {
  const mocks = setup();
  try {
    await body(mocks);
  } finally {
    if (typeof (mocks as Restorable).restore === "function") {
      (mocks as Restorable).restore?.();
    } else {
      for (const mock of Object.values(mocks as Record<string, Restorable>)) {
        mock.restore?.();
      }
    }
    await cleanup?.();
  }
};

/** Temporarily replace bunnyCdnApi methods and restore after test */
export const withMockBunnyCdnApi = async (
  overrides: Partial<typeof bunnyCdnApi>,
  fn: () => Promise<void>,
): Promise<void> => {
  const originals: Partial<typeof bunnyCdnApi> = {};
  for (const key of Object.keys(overrides) as (keyof typeof bunnyCdnApi)[]) {
    // deno-lint-ignore no-explicit-any
    originals[key] = bunnyCdnApi[key] as any;
    // deno-lint-ignore no-explicit-any
    bunnyCdnApi[key] = overrides[key] as any;
  }
  try {
    await fn();
  } finally {
    Object.assign(bunnyCdnApi, originals);
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
  maxPrice: 10000,
  thankYouUrl: "https://example.com/thanks",
  ...overrides,
});

/** Cached session for test event creation */
let testSession: { cookie: string; csrfToken: string } | null = null;

/**
 * Create an admin session directly in the DB without going through handleRequest().
 * This avoids the isSetupComplete() check in the request pipeline, which can
 * return false under parallel test execution when another worker invalidates
 * the shared settings cache singleton between loadAll() and isSetupComplete().
 */
const createDirectAdminSession = async (): Promise<{
  cookie: string;
  csrfToken: string;
}> => {
  const { generateSecureToken } = await import("#lib/crypto/utils.ts");
  const { deriveKEK, unwrapKey, wrapKeyWithToken } = await import(
    "#lib/crypto/keys.ts"
  );
  const { createSession: createDbSession } = await import(
    "#lib/db/sessions.ts"
  );
  const { buildSessionCookie } = await import("#lib/cookies.ts");
  const { getUserByUsername, verifyUserPassword } = await import(
    "#lib/db/users.ts"
  );
  const { nowMs } = await import("#lib/now.ts");

  const user = await getUserByUsername(TEST_ADMIN_USERNAME);
  if (!user?.wrapped_data_key)
    throw new Error("Admin user not found after setup");
  const passwordHash = await verifyUserPassword(user, TEST_ADMIN_PASSWORD);
  if (!passwordHash)
    throw new Error("Admin password verification failed after setup");
  const kek = await deriveKEK(passwordHash);
  const dataKey = await unwrapKey(user.wrapped_data_key, kek);

  const token = generateSecureToken();
  const csrfToken = generateSecureToken();
  const expires = nowMs() + 24 * 60 * 60 * 1000;
  const wrappedDataKey = await wrapKeyWithToken(dataKey, token);
  await createDbSession(token, csrfToken, expires, wrappedDataKey, user.id);

  const cookie = buildSessionCookie(token);
  const signedCsrf = await signCsrfToken();
  return { cookie, csrfToken: signedCsrf };
};

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

  const loginPageResponse = await handleRequest(mockRequest("/admin/"));
  const loginHtml = await loginPageResponse.text();
  const loginCsrfToken = extractCsrfToken(loginHtml);

  if (!loginCsrfToken) {
    throw new Error("Failed to get CSRF token for admin login");
  }

  const loginResponse = await handleRequest(
    await mockAdminLoginRequest(
      { username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD },
      loginCsrfToken,
    ),
  );
  loginResponse.body?.cancel();
  const cookie = loginResponse.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${getSessionCookieName()}=`));
  if (!cookie) throw new Error("No session cookie in login response");
  const csrfToken = await signCsrfToken();

  return { cookie, csrfToken };
};

/**
 * Create a test event and log in as admin in one call.
 * Shorthand for the extremely common `createTestEvent()` + `loginAsAdmin()` combo.
 */
export const setupEventAndLogin = async (
  overrides?: Parameters<typeof createTestEvent>[0],
): Promise<{
  event: Event;
  cookie: string;
  csrfToken: string;
}> => {
  const event = await createTestEvent(overrides);
  const { cookie, csrfToken } = await getTestSession();
  return { event, cookie, csrfToken };
};

/** Get or create an authenticated session for test helpers (cached) */
export const getTestSession = async (): Promise<{
  cookie: string;
  csrfToken: string;
}> => {
  if (testSession) return testSession;

  // Fast path: restore cached session directly into the DB
  if (cachedAdminSession) {
    const { sessionRow } = cachedAdminSession;
    await getDb().execute({
      sql: "INSERT INTO sessions (token, csrf_token, expires, wrapped_data_key, user_id) VALUES (?, ?, ?, ?, ?)",
      args: [
        sessionRow.token,
        sessionRow.csrf_token,
        sessionRow.expires,
        sessionRow.wrapped_data_key,
        sessionRow.user_id,
      ],
    });
    const csrfToken = await signCsrfToken();
    testSession = { cookie: cachedAdminSession.cookie, csrfToken };
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
 * Convenience accessors for the cached admin session.
 * Lazily initializes via getTestSession() on first call per test.
 * Use instead of `const { cookie, csrfToken } = await getTestSession()`.
 */
export const testCookie = async (): Promise<string> =>
  (await getTestSession()).cookie;
export const testCsrfToken = async (): Promise<string> =>
  (await getTestSession()).csrfToken;

/**
 * Execute an authenticated request expecting a redirect.
 * Handles session management, CSRF tokens, and status validation.
 */
const authenticatedRequest = async <T>(
  buildRequest: (
    path: string,
    data: Record<string, string>,
    cookie: string,
  ) => Request,
  path: string,
  formData: Record<string, string>,
  onSuccess: () => Promise<T>,
  errorContext: string,
): Promise<T> => {
  const session = await getTestSession();
  const { handleRequest } = await import("#routes");

  const response = await handleRequest(
    buildRequest(
      path,
      { ...formData, csrf_token: session.csrfToken },
      session.cookie,
    ),
  );
  response.body?.cancel();

  if (response.status !== 302) {
    throw new Error(`Failed to ${errorContext}: ${response.status}`);
  }

  return onSuccess();
};

/** Authenticated URL-encoded form request (deactivate, holidays, etc.) */
const authenticatedFormRequest = <T>(
  path: string,
  formData: Record<string, string>,
  onSuccess: () => Promise<T>,
  errorContext: string,
): Promise<T> =>
  authenticatedRequest(
    mockFormRequest,
    path,
    formData,
    onSuccess,
    errorContext,
  );

/** Authenticated multipart form request (event create/edit with file uploads) */
const authenticatedMultipartFormRequest = <T>(
  path: string,
  formData: Record<string, string>,
  onSuccess: () => Promise<T>,
  errorContext: string,
): Promise<T> =>
  authenticatedRequest(
    mockMultipartRequest,
    path,
    formData,
    onSuccess,
    errorContext,
  );

/**
 * Create an event via the REST API
 * This is the preferred way to create test events as it exercises production code.
 * Slugs are auto-generated, so we look up the event by querying the latest one.
 */
export const createTestEvent = (
  overrides: Partial<Omit<EventInput, "slug" | "slugIndex">> = {},
): Promise<Event> => {
  const input = testEventInput(overrides);

  const closesAtParts = splitClosesAt(input.closesAt, null);
  const dateParts = splitClosesAt(input.date, null);

  return authenticatedMultipartFormRequest(
    "/admin/event",
    {
      name: input.name,
      description: input.description ?? "",
      date_date: dateParts.date,
      date_time: dateParts.time,
      location: input.location ?? "",
      group_id: String(input.groupId ?? 0),
      max_attendees: String(input.maxAttendees),
      max_quantity: String(input.maxQuantity ?? 1),
      fields: input.fields ?? "email",
      thank_you_url: input.thankYouUrl ?? "",
      unit_price:
        input.unitPrice != null ? priceFormValue(input.unitPrice) : "",
      webhook_url: input.webhookUrl ?? "",
      closes_at_date: closesAtParts.date,
      closes_at_time: closesAtParts.time,
      event_type: input.eventType ?? "",
      bookable_days: input.bookableDays
        ? formatBookableDaysForForm(input.bookableDays)
        : "",
      minimum_days_before:
        input.minimumDaysBefore != null ? String(input.minimumDaysBefore) : "",
      maximum_days_after:
        input.maximumDaysAfter != null ? String(input.maximumDaysAfter) : "",
      non_transferable: input.nonTransferable ? "1" : "",
      can_pay_more: input.canPayMore ? "1" : "",
      max_price: priceFormValue(input.maxPrice),
      hidden: input.hidden ? "1" : "",
      purchase_only: input.purchaseOnly ? "1" : "",
    },
    async () => {
      // Get the most recently created event (302 redirect guarantees creation succeeded)
      const { getAllEvents } = await import("#lib/db/events.ts");
      const events = await getAllEvents();
      return events[0] as Event; // getAllEvents returns DESC by created
    },
    "create event",
  );
};

/**
 * Create an embeddable test event and return its ticket page response.
 * Useful for testing security headers, CSP, and embed behavior on ticket pages.
 */
export const getEmbeddableTicketResponse = async (): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  const event = await createTestEvent({
    maxAttendees: 50,
    thankYouUrl: "https://example.com",
  });
  return handleRequest(mockRequest(`/ticket/${event.slug}`));
};

/** Convert a price in minor units to the form value in major units */
export const priceFormValue = (minorUnits: number): string =>
  toMajorUnits(minorUnits);

/** Format optional price field for form submission (converts minor → major units) */
const formatPrice = (update: number | undefined, existing: number): string =>
  update !== undefined ? priceFormValue(update) : priceFormValue(existing);

/** Format optional string field for form submission */
const formatOptional = (update: string | undefined, existing: string): string =>
  update ?? existing;

/** Format bookable_days array to comma-separated string for form submission */
const formatBookableDaysForForm = (days: string[]): string => days.join(",");

/** Split a closes_at value into date and time parts for form submission */
const splitClosesAt = (
  update: string | undefined,
  existing: string | null,
): { date: string; time: string } => {
  const value = update !== undefined ? update : (existing?.slice(0, 16) ?? "");
  if (!value) return { date: "", time: "" };
  const [date = "", time = ""] = value.split("T");
  return { date, time };
};

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

  const closesAtParts = splitClosesAt(updates.closesAt, existing.closes_at);
  const dateParts = splitClosesAt(updates.date, existing.date);

  return authenticatedMultipartFormRequest(
    `/admin/event/${eventId}/edit`,
    {
      name: updates.name ?? existing.name,
      description: updates.description ?? existing.description,
      date_date: dateParts.date,
      date_time: dateParts.time,
      location: updates.location ?? existing.location,
      group_id: String(updates.groupId ?? existing.group_id),
      slug: updates.slug ?? existing.slug,
      max_attendees: String(updates.maxAttendees ?? existing.max_attendees),
      max_quantity: String(updates.maxQuantity ?? existing.max_quantity),
      fields: updates.fields ?? existing.fields,
      thank_you_url: formatOptional(
        updates.thankYouUrl,
        existing.thank_you_url,
      ),
      unit_price: formatPrice(updates.unitPrice, existing.unit_price),
      webhook_url: formatOptional(updates.webhookUrl, existing.webhook_url),
      closes_at_date: closesAtParts.date,
      closes_at_time: closesAtParts.time,
      event_type: updates.eventType ?? existing.event_type,
      bookable_days: updates.bookableDays
        ? formatBookableDaysForForm(updates.bookableDays)
        : formatBookableDaysForForm(existing.bookable_days),
      minimum_days_before: String(
        updates.minimumDaysBefore ?? existing.minimum_days_before,
      ),
      maximum_days_after: String(
        updates.maximumDaysAfter ?? existing.maximum_days_after,
      ),
      non_transferable:
        (updates.nonTransferable ?? existing.non_transferable) ? "1" : "",
      can_pay_more: (updates.canPayMore ?? existing.can_pay_more) ? "1" : "",
      max_price: priceFormValue(updates.maxPrice ?? existing.max_price),
      hidden: (updates.hidden ?? existing.hidden) ? "1" : "",
    },
    async () => (await getEventWithCount(eventId)) as EventWithCount,
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

  // Get the ticket page to get a CSRF token from HTML
  const pageResponse = await handleRequest(mockRequest(`/ticket/${eventSlug}`));
  const pageHtml = await pageResponse.text();
  // Fall back to a signed token when the page doesn't show a form
  // (e.g. event at capacity / sold out / deactivated)
  const csrfToken = extractCsrfToken(pageHtml) ?? (await signCsrfToken());

  // Submit the ticket form (using quantity_{eventId} format)
  const response = await handleRequest(
    mockTicketFormRequest(
      eventSlug,
      { name, email, phone, [`quantity_${eventId}`]: String(quantity) },
      csrfToken,
    ),
  );

  // Free events redirect to thank you page (302)
  // Paid events redirect to Stripe (303)
  // Error redirects are also 302 but carry an error flash cookie
  if (response.status !== 302 && response.status !== 303) {
    const body = await response.text();
    throw new Error(
      `Failed to create attendee: ${response.status} - ${body.slice(0, 200)}`,
    );
  }

  // Detect error redirects (302 with error flash cookie)
  const flashCookie = response.headers
    .getSetCookie()
    .find((c) => c.startsWith("flash_"));
  if (flashCookie) {
    const cookiePart = flashCookie.split(";")[0] ?? "";
    const value = cookiePart.split("=").slice(1).join("=");
    const parsed = parseFlashValue(value);
    if (parsed.error) {
      response.body?.cancel();
      throw new Error(`Failed to create attendee: ${parsed.error}`);
    }
  }

  response.body?.cancel();

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

import { expect } from "@std/expect";

/** Assert a Response has the given status code. Returns the response for chaining. */
export const expectStatus =
  (status: number) =>
  (response: Response): Response => {
    expect(response.status).toBe(status);
    return response;
  };

/**
 * Assert status, parse JSON body, and run assertions on the result.
 * Curried for pipe-friendly use.
 *
 * @example
 * // Inline assertions
 * const body = await expectJsonResponse(201, (b) => {
 *   expect(b.event.name).toBe("New Event");
 * })(response);
 *
 * // Status-only (just parse)
 * const body = await expectJsonResponse(200)(response);
 */
export const expectJsonResponse =
  // deno-lint-ignore no-explicit-any
    <T = any>(status: number, assertions?: (body: T) => void) =>
    async (response: Response): Promise<T> => {
      expect(response.status).toBe(status);
      const body = (await response.json()) as T;
      assertions?.(body);
      return body;
    };

/**
 * Assert status and JSON body on a response promise in one call.
 * Composes any Promise<Response> with expectJsonResponse — works with
 * apiRequest, handleRequest, or any other request helper.
 *
 * @example
 * await assertJson(apiRequest("/api/events", { method: "POST", body }), 201, (b) => {
 *   expect(b.event.name).toBe("New Event");
 * });
 *
 * await assertJson(handleRequest(mockWebhookRequest()), 200, (b) => {
 *   expect(b.received).toBe(true);
 * });
 */
// deno-lint-ignore no-explicit-any
export const assertJson = async <T = any>(
  request: Promise<Response>,
  status: number,
  assertions?: (body: T) => void,
): Promise<T> => {
  const response = await request;
  return expectJsonResponse<T>(status, assertions)(response);
};

/**
 * Submit an admin form and assert the response redirects with a flash message.
 * Combines adminFormPost + expectRedirectWithFlash in one call.
 *
 * @example
 * await assertFormRedirect("/admin/settings", { country: "US" }, "/admin/settings", "Country updated");
 */
export const assertFormRedirect = async (
  path: string,
  data: Record<string, string>,
  redirectTo: string,
  flashMessage: string,
): Promise<Response> => {
  const { response } = await adminFormPost(path, data);
  expectRedirectWithFlash(redirectTo, flashMessage)(response);
  return response;
};

/**
 * Fetch an admin page and assert the HTML contains all given substrings.
 * Returns the HTML for further assertions.
 *
 * @example
 * await assertAdminHtml("/admin/guide", "Getting Started", "Events");
 *
 * const html = await assertAdminHtml("/admin/debug", "queries");
 * expect(html).not.toContain("secret");
 */
export const assertAdminHtml = async (
  path: string,
  ...substrings: string[]
): Promise<string> => {
  const { response } = await adminGet(path);
  const html = await response.text();
  for (const s of substrings) expect(html).toContain(s);
  return html;
};

/**
 * Assert status and check that the HTML body contains all given substrings.
 * Returns the HTML string for further assertions.
 */
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

/** Assert a Response is a 302 redirect whose location matches all patterns.
 *  Strings are checked with toContain, RegExps with toMatch.
 *  Returns the location for further inspection. */
export const expectRedirect = (
  response: Response,
  ...patterns: (string | RegExp)[]
): string => {
  expect(response.status).toBe(302);
  response.body?.cancel();
  const location = getRedirectLocation(response);
  for (const p of patterns) {
    if (typeof p === "string") {
      expect(location).toContain(p);
    } else {
      expect(location).toMatch(p);
    }
  }
  return location;
};

/** Shorthand: assert redirect to /admin */
export const expectAdminRedirect = (response: Response): string =>
  expectRedirect(response, "/admin");

/** Fixed flash ID used in tests for deterministic keyed cookies */
export const FLASH_TEST_ID = "t001";

/**
 * Assert the response carries a keyed flash cookie with the given message.
 * Finds any cookie starting with "flash_" prefix.
 * Works on both redirect (302) and rendered (200) responses.
 */
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
  // Cookie is "flash_{id}={value}", extract value after first "="
  const value = cookiePart.split("=").slice(1).join("=");
  const parsed = parseFlashValue(value);
  const actual = succeeded ? parsed.success : parsed.error;
  if (message !== undefined) expect(actual).toEqual(message);
  return response;
};

/**
 * Assert a redirect (302) to the given location with a flash message.
 * Extracts the flash ID from the redirect URL and verifies the keyed cookie.
 * Compares the location without the flash param for clean assertions.
 */
export const expectRedirectWithFlash =
  // deno-lint-ignore no-explicit-any
    (location: string, message?: string | any, succeeded = true) =>
    (response: Response): Response => {
      const actualLocation = expectRedirect(response);
      const url = new URL(actualLocation, "http://localhost");
      const flashId = url.searchParams.get("flash");
      expect(flashId).toBeDefined();
      // Compare location without flash param
      url.searchParams.delete("flash");
      const clean = url.pathname + url.search + url.hash;
      expect(clean).toBe(location);
      expectFlash(response, message, succeeded);
      return response;
    };

/**
 * Build a cookie header string containing a keyed flash message.
 * Use in mockRequest to simulate a flash cookie from a previous redirect.
 * Uses FLASH_TEST_ID as the key — pair with ?flash=test01 in the URL.
 */
export const flashCookieHeader = (
  message: string,
  succeeded = true,
): string => {
  const type = succeeded ? "s" : "e";
  const payload = JSON.stringify({ t: type, m: message });
  return `flash_${FLASH_TEST_ID}=${encodeURIComponent(payload)}`;
};

/** Assert response is a checkout redirect (302 to an external HTTPS URL) */
export const expectCheckoutRedirect = (response: Response): string =>
  expectRedirect(response, /^https:\/\//);

/** Follow a 302 redirect by making a new request to the location header. */
export const followRedirect = (
  response: Response,
  handler: (request: Request) => Promise<Response>,
): Promise<Response> => handler(mockRequest(expectRedirect(response)));

/**
 * Follow a 302 redirect, carrying the Set-Cookie flash cookie into the
 * follow-up GET request so the flash context is populated by middleware.
 */
export const followRedirectWithFlash = (
  response: Response,
  handler: (request: Request) => Promise<Response>,
  extraCookie?: string,
): Promise<Response> => {
  const location = expectRedirect(response);
  const setCookies = response.headers.getSetCookie();
  const flashCookie = setCookies
    .map((c) => c.split(";")[0])
    .filter((c) => c?.startsWith("flash_"))
    .join("; ");
  const cookie = [flashCookie, extraCookie].filter(Boolean).join("; ");
  return handler(mockRequest(location, cookie ? { headers: { cookie } } : {}));
};

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

/** Get a response header, throwing if missing. */
export const getHeader = (response: Response, name: string): string => {
  const value = response.headers.get(name);
  if (value === null) throw new Error(`Missing expected header: ${name}`);
  return value;
};

/** Get the Location header from a response, throwing if missing. */
const getRedirectLocation = (response: Response): string =>
  getHeader(response, "location");

/** Match a regex against text and return the given capture group, throwing if no match. */
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
  date: "",
  location: "",
  slug: "ab12c",
  slug_index: "test-event-index",
  group_id: 0,
  max_attendees: 100,
  thank_you_url: "https://example.com/thanks",
  created: "2024-01-01T00:00:00Z",
  unit_price: 0,
  max_quantity: 1,
  webhook_url: "",
  closes_at: null,
  active: true,
  fields: "email",
  event_type: "standard",
  bookable_days: [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ],
  minimum_days_before: 0,
  maximum_days_after: 0,
  image_url: "",
  attachment_url: "",
  attachment_name: "",
  non_transferable: false,
  can_pay_more: false,
  max_price: 0,
  hidden: false,
  purchase_only: false,
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
  address: "",
  special_instructions: "",
  created: "2024-01-01T12:00:00Z",
  payment_id: "",
  quantity: 1,
  price_paid: "0",
  checked_in: false,
  refunded: false,
  ticket_token: "test-token-1",
  ticket_token_index: "test-token-index-1",
  date: null,
  attachment_downloads: 0,
  pii_blob: "",
  ...overrides,
});

// ---------------------------------------------------------------------------
// Form validation helpers
// Curried helpers for the common validate-then-assert pattern in form tests.
// ---------------------------------------------------------------------------

import { type Field, validateForm } from "#lib/forms.tsx";

/** Validate form data and return the result. Shared core for assertion helpers. */
const validateFormData = (fields: Field[], data: Record<string, string>) =>
  validateForm(new FormParams(data), fields);

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
/**
 * GET a page and extract its CSRF token from the hidden form field.
 * Throws if the page doesn't contain a CSRF token.
 */
export const getPageCsrfToken = async (path: string): Promise<string> => {
  const { handleRequest } = await import("#routes");
  const response = await handleRequest(mockRequest(path));
  const html = await response.text();
  const token = extractCsrfToken(html);
  if (!token) throw new Error(`Failed to get CSRF token from ${path}`);
  return token;
};

/**
 * Submit the /join/:code form with automatic CSRF token handling.
 * GETs the join page to obtain the CSRF token, then POSTs the form.
 */
export const submitJoinForm = async (
  inviteCode: string,
  data: { password: string; password_confirm: string },
): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  const joinGetResponse = await handleRequest(
    mockRequest(`/join/${inviteCode}`),
  );
  const joinHtml = await joinGetResponse.text();
  const joinCsrf = requireJoinCsrfToken(joinHtml);
  return handleRequest(
    mockFormRequest(`/join/${inviteCode}`, { ...data, csrf_token: joinCsrf }),
  );
};

/**
 * Create an invited user via the admin API and return the invite code.
 * Logs in as admin, creates the invite, and extracts the code from the redirect.
 */
export const createTestInvite = async (
  username: string,
  adminLevel = "manager",
): Promise<{ inviteCode: string; cookie: string; csrfToken: string }> => {
  const { cookie, csrfToken } = await getTestSession();
  const { handleRequest } = await import("#routes");
  const inviteResponse = await handleRequest(
    mockFormRequest(
      "/admin/users",
      { username, admin_level: adminLevel, csrf_token: csrfToken },
      cookie,
    ),
  );
  inviteResponse.body?.cancel();
  const location = inviteResponse.headers.get("location") ?? "";
  const url = new URL(location, "http://localhost");
  const inviteLink = url.searchParams.get("invite") ?? "";
  const codeMatch = inviteLink.match(/\/join\/([A-Za-z0-9_-]+)/);
  if (!codeMatch?.[1]) {
    throw new Error(
      `Failed to create invite for ${username}: ${inviteResponse.status} ${location}`,
    );
  }
  return { inviteCode: codeMatch[1], cookie, csrfToken };
};

/** Extract event ID from a ticket page's quantity field name (quantity_123 → "123") */
const extractQuantityEventId = (html: string): string | null => {
  const match = html.match(/name="quantity_(\d+)"/);
  return match?.[1] ?? null;
};

/** Normalize single-event form fields to per-event format (quantity → quantity_{id},
 * custom_price → custom_price_{id}). When no event ID can be extracted from the HTML
 * (e.g. sold-out page with no form), returns data unchanged. */
const normalizeSingleEventFields = (
  data: Record<string, string>,
  html: string,
): Record<string, string> => {
  const eventId = extractQuantityEventId(html);
  if (!eventId) return data;
  const result = { ...data };
  // Normalize quantity
  if (!(`quantity_${eventId}` in result)) {
    if ("quantity" in result) {
      result[`quantity_${eventId}`] = result.quantity;
      delete result.quantity;
    } else {
      result[`quantity_${eventId}`] = "1";
    }
  }
  // Normalize custom_price
  if ("custom_price" in result && !(`custom_price_${eventId}` in result)) {
    result[`custom_price_${eventId}`] = result.custom_price;
    delete result.custom_price;
  }
  return result;
};

/**
 * Submit a ticket form with automatic CSRF token handling.
 * GETs the ticket page first to obtain a CSRF token, then POSTs the form.
 * Automatically converts `quantity` to `quantity_{eventId}` for single-event forms.
 */
export const submitTicketForm = async (
  slug: string,
  data: Record<string, string>,
): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  const getResponse = await handleRequest(mockRequest(`/ticket/${slug}`));
  const html = await getResponse.text();
  // Extract from form HTML, or fall back to a signed token when the page
  // doesn't show a form (e.g. event at capacity / sold out)
  const csrfToken = extractCsrfToken(html) ?? (await signCsrfToken());
  const normalizedData = normalizeSingleEventFields(data, html);
  return handleRequest(mockTicketFormRequest(slug, normalizedData, csrfToken));
};

/**
 * Submit a ticket form for multi-slug URLs (e.g. "slug1+slug2").
 * GETs the page first to obtain a CSRF token, then POSTs the form.
 */
export const submitMultiTicketForm = async (
  slug: string,
  data: Record<string, string>,
): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  const path = `/ticket/${slug}`;
  const getResponse = await handleRequest(mockRequest(path));
  const csrfToken = extractCsrfToken(await getResponse.text()) ?? "";
  if (!csrfToken) throw new Error("No CSRF token found on ticket page");
  return handleRequest(
    mockFormRequest(
      path,
      { ...data, csrf_token: csrfToken },
      `csrf_token=${csrfToken}`,
    ),
  );
};

/**
 * Configure Stripe as the payment provider for tests.
 */
export const setupStripe = async (key = "sk_test_mock"): Promise<void> => {
  const { settings: s } = await import("#lib/db/settings.ts");
  await s.update.stripe.secretKey(key);
  await s.update.paymentProvider("stripe");
};

/**
 * Add the test-environment origin marker to webhook session metadata.
 * Checkout sessions created by this instance carry an _origin field so the
 * webhook handler can ignore sessions from unrelated applications sharing the
 * same payment provider account.
 */
export const webhookMeta = (
  metadata: Partial<SessionMetadata> & { name: string },
): SessionMetadata => ({
  _origin: "localhost",
  email: "",
  phone: "",
  address: "",
  special_instructions: "",
  items: "",
  date: "",
  answer_ids: "",
  ...metadata,
});

/** Build items metadata for a single-event checkout in tests */
export const singleItem = (
  eventId: number,
  quantity: number,
  price: number,
): string => JSON.stringify([{ e: eventId, q: quantity, p: price }]);

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

/** Create a test Group with sensible defaults. Override any field via `overrides`. */
export const testGroup = (overrides: Partial<Group> = {}): Group => ({
  id: 1,
  name: "Test Group",
  slug: "test-group",
  slug_index: "test-group-index",
  description: "",
  terms_and_conditions: "",
  max_attendees: 0,
  hidden: false,
  ...overrides,
});

/**
 * Create a group via the REST API.
 * Slug is auto-generated on creation. If a slug is provided,
 * the group is updated after creation to set the desired slug.
 */
export const createTestGroup = async (
  overrides: Partial<Omit<GroupInput, "slugIndex">> = {},
): Promise<Group> => {
  const input = {
    name: overrides.name ?? "Test Group",
    description: overrides.description ?? "",
    termsAndConditions: overrides.termsAndConditions ?? "",
    maxAttendees: overrides.maxAttendees ?? 0,
    hidden: overrides.hidden ?? false,
  };

  const group = await authenticatedFormRequest(
    "/admin/groups",
    {
      name: input.name,
      description: input.description,
      terms_and_conditions: input.termsAndConditions,
      max_attendees: String(input.maxAttendees),
      ...(input.hidden ? { hidden: "1" } : {}),
    },
    async () => {
      const { getAllGroups } = await import("#lib/db/groups.ts");
      const groups = await getAllGroups();
      return groups[groups.length - 1] as Group;
    },
    "create group",
  );

  if (overrides.slug) {
    return updateTestGroup(group.id, {
      name: group.name,
      slug: overrides.slug,
      description: group.description,
      termsAndConditions: group.terms_and_conditions,
      maxAttendees: group.max_attendees,
      hidden: group.hidden,
    });
  }

  return group;
};

/**
 * Update a group via the REST API
 */
export const updateTestGroup = async (
  groupId: number,
  updates: Partial<Omit<GroupInput, "slugIndex">>,
): Promise<Group> => {
  const { groupsTable } = await import("#lib/db/groups.ts");
  const existing = (await groupsTable.findById(groupId)) as Group;

  const hidden = updates.hidden ?? existing.hidden;
  return authenticatedFormRequest(
    `/admin/groups/${groupId}/edit`,
    {
      name: updates.name ?? existing.name,
      slug: updates.slug ?? existing.slug,
      description: updates.description ?? existing.description,
      terms_and_conditions:
        updates.termsAndConditions ?? existing.terms_and_conditions,
      max_attendees: String(updates.maxAttendees ?? existing.max_attendees),
      ...(hidden ? { hidden: "1" } : {}),
    },
    async () => {
      const updated = await groupsTable.findById(groupId);
      return updated as Group;
    },
    "update group",
  );
};

/**
 * Delete a group via the REST API
 */
export const deleteTestGroup = async (groupId: number): Promise<void> => {
  const { groupsTable } = await import("#lib/db/groups.ts");
  const existing = (await groupsTable.findById(groupId)) as Group;

  return authenticatedFormRequest(
    `/admin/groups/${groupId}/delete`,
    { confirm_identifier: existing.name },
    async () => {},
    "delete group",
  );
};

import type { HolidayInput } from "#lib/db/holidays.ts";
import type { Holiday } from "#lib/types.ts";

/** Create a test Holiday with sensible defaults. Override any field via `overrides`. */
export const testHoliday = (overrides: Partial<Holiday> = {}): Holiday => ({
  id: 1,
  name: "Test Holiday",
  start_date: "2026-12-25",
  end_date: "2026-12-25",
  ...overrides,
});

/**
 * Create a holiday via the REST API
 */
export const createTestHoliday = (
  overrides: Partial<HolidayInput> = {},
): Promise<Holiday> => {
  const input: HolidayInput = {
    name: overrides.name ?? "Test Holiday",
    startDate: overrides.startDate ?? "2026-12-25",
    endDate: overrides.endDate ?? "2026-12-25",
  };

  return authenticatedFormRequest(
    "/admin/holidays",
    {
      name: input.name,
      start_date: input.startDate,
      end_date: input.endDate,
    },
    async () => {
      const { getAllHolidays } = await import("#lib/db/holidays.ts");
      const holidays = await getAllHolidays();
      return holidays[holidays.length - 1] as Holiday;
    },
    "create holiday",
  );
};

/**
 * Update a holiday via the REST API
 */
export const updateTestHoliday = async (
  holidayId: number,
  updates: Partial<HolidayInput>,
): Promise<Holiday> => {
  const { holidaysTable } = await import("#lib/db/holidays.ts");
  const existing = (await holidaysTable.findById(holidayId)) as Holiday;

  return authenticatedFormRequest(
    `/admin/holidays/${holidayId}/edit`,
    {
      name: updates.name ?? existing.name,
      start_date: updates.startDate ?? existing.start_date,
      end_date: updates.endDate ?? existing.end_date,
    },
    async () => {
      const updated = await holidaysTable.findById(holidayId);
      return updated as Holiday;
    },
    "update holiday",
  );
};

/**
 * Delete a holiday via the REST API
 */
export const deleteTestHoliday = async (holidayId: number): Promise<void> => {
  const { holidaysTable } = await import("#lib/db/holidays.ts");
  const existing = (await holidaysTable.findById(holidayId)) as Holiday;

  return authenticatedFormRequest(
    `/admin/holidays/${holidayId}/delete`,
    { confirm_identifier: existing.name },
    async () => {},
    "delete holiday",
  );
};

export type { GroupInput, HolidayInput };

import type { BuiltSite, BuiltSiteFormInput } from "#lib/db/built-sites.ts";

/** Create a test BuiltSite with sensible defaults. Override any field via `overrides`. */
export const testBuiltSite = (
  overrides: Partial<BuiltSite> = {},
): BuiltSite => ({
  id: 1,
  name: "Test Site",
  bunnyUrl: "https://test.b-cdn.net",
  created: "2026-01-01T00:00:00Z",
  ...overrides,
});

/**
 * Create a built site via the REST API
 */
export const createTestBuiltSite = (
  overrides: Partial<BuiltSiteFormInput> = {},
): Promise<BuiltSite> => {
  const input: BuiltSiteFormInput = {
    name: overrides.name ?? "Test Site",
    bunnyUrl: overrides.bunnyUrl ?? "https://test.b-cdn.net",
  };

  return authenticatedFormRequest(
    "/admin/built-sites",
    {
      name: input.name,
      bunny_url: input.bunnyUrl,
    },
    async () => {
      const { getAllBuiltSites } = await import("#lib/db/built-sites.ts");
      const sites = await getAllBuiltSites();
      return sites[sites.length - 1] as BuiltSite;
    },
    "create built site",
  );
};

/**
 * Update a built site via the REST API
 */
export const updateTestBuiltSite = async (
  siteId: number,
  updates: Partial<BuiltSiteFormInput>,
): Promise<BuiltSite> => {
  const { builtSitesCrudTable } = await import("#lib/db/built-sites.ts");
  const existing = (await builtSitesCrudTable.findById(siteId)) as BuiltSite;

  return authenticatedFormRequest(
    `/admin/built-sites/${siteId}/edit`,
    {
      name: updates.name ?? existing.name,
      bunny_url: updates.bunnyUrl ?? existing.bunnyUrl,
    },
    async () => {
      const updated = await builtSitesCrudTable.findById(siteId);
      return updated as BuiltSite;
    },
    "update built site",
  );
};

/**
 * Delete a built site via the REST API
 */
export const deleteTestBuiltSite = async (siteId: number): Promise<void> => {
  const { builtSitesCrudTable } = await import("#lib/db/built-sites.ts");
  const existing = (await builtSitesCrudTable.findById(siteId)) as BuiltSite;

  return authenticatedFormRequest(
    `/admin/built-sites/${siteId}/delete`,
    { confirm_identifier: existing.name },
    async () => {},
    "delete built site",
  );
};

export type { BuiltSiteFormInput };

/**
 * Create an attendee directly using createAttendeeAtomic (bypasses HTTP layer).
 * Returns the plaintext token just like production code receives it.
 * This matches the real-world flow where plaintext token comes from createAttendeeAtomic result.
 */
export const createTestAttendeeDirect = async (
  eventId: number,
  name: string,
  email: string,
  quantity = 1,
  phone = "",
  address = "",
  special_instructions = "",
): Promise<{ attendee: Attendee; token: string }> => {
  const { createAttendeeAtomic } = await import("#lib/db/attendees.ts");

  const result = await createAttendeeAtomic({
    name,
    email,
    phone,
    address,
    special_instructions,
    bookings: [{ eventId, quantity }],
  });

  if (!result.success) {
    throw new Error(`Failed to create attendee: ${result.reason}`);
  }

  // The token in result.attendees[0] is plaintext, just like production!
  return {
    attendee: result.attendees[0]!,
    token: result.attendees[0]!.ticket_token,
  };
};

/**
 * Create an attendee and return both the attendee and their ticket token.
 * Combines createTestAttendee + getAttendeesRaw into a single call.
 */
export const createTestAttendeeWithToken = async (
  name: string,
  email: string,
  eventOverrides: Partial<Omit<EventInput, "slug" | "slugIndex">> = {},
  quantity = 1,
  phone = "",
): Promise<{ event: Event; attendee: Attendee; token: string }> => {
  const event = await createTestEvent({ maxAttendees: 10, ...eventOverrides });
  const { attendee, token } = await createTestAttendeeDirect(
    event.id,
    name,
    email,
    quantity,
    phone,
  );
  return { event, attendee, token };
};

/**
 * Perform an admin POST with form data (auto-login + auto-CSRF).
 * Logs in as admin, injects the CSRF token, and submits the form.
 * To test invalid CSRF, include csrf_token in data to override the default.
 */
export const adminFormPost = async (
  path: string,
  data: Record<string, string> = {},
): Promise<{ response: Response; cookie: string; csrfToken: string }> => {
  const { cookie, csrfToken } = await getTestSession();
  const { handleRequest } = await import("#routes");
  const response = await handleRequest(
    mockFormRequest(path, { csrf_token: csrfToken, ...data }, cookie),
  );
  return { response, cookie, csrfToken };
};

/**
 * Perform an authenticated admin GET request (auto-login).
 */
export const adminGet = async (
  path: string,
): Promise<{ response: Response; cookie: string; csrfToken: string }> => {
  const { cookie, csrfToken } = await getTestSession();
  const response = await awaitTestRequest(path, { cookie });
  return { response, cookie, csrfToken };
};

const allDays: string[] = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/**
 * Create a daily event with all days bookable. Reduces boilerplate in calendar tests.
 */
export const createDailyTestEvent = (
  overrides: Partial<Omit<EventInput, "slug" | "slugIndex">> = {},
) =>
  createTestEvent({
    eventType: "daily",
    bookableDays: allDays,
    minimumDaysBefore: 0,
    maximumDaysAfter: 14,
    ...overrides,
  });

/**
 * Create a paid test attendee directly via createAttendeeAtomic.
 * Use this instead of createTestAttendee when you need a payment_id on the attendee.
 */
export const createPaidTestAttendee = async (
  eventId: number,
  name: string,
  email: string,
  paymentId: string,
  pricePaid = 500,
  quantity = 1,
): Promise<Attendee> => {
  const { createAttendeeAtomic } = await import("#lib/db/attendees.ts");
  const result = await createAttendeeAtomic({
    name,
    email,
    paymentId,
    bookings: [{ eventId, quantity, pricePaid }],
  });
  // success is guaranteed when event capacity is available
  return (result as { success: true; attendees: Attendee[] }).attendees[0]!;
};

import type { PaymentProviderType, SessionMetadata } from "#lib/payments.ts";

/** Mock return type for getConfiguredProvider */
export const mockProviderType = (
  type: PaymentProviderType,
): PaymentProviderType | null => type;

// ---------------------------------------------------------------------------
// Admin test context helpers
// Curried helpers for common admin test patterns (event + attendee + session).
// Eliminates the repeated setup boilerplate in admin route tests.
// ---------------------------------------------------------------------------

export type AdminTestContext = {
  event: Event;
  attendee: Attendee;
  cookie: string;
  csrfToken: string;
};

/**
 * Creates standard admin test context: event + attendee + admin session.
 * Use directly when tests need custom request flows beyond the curried helpers.
 */
export const setupAdminTest = async (
  eventOverrides: Partial<Omit<EventInput, "slug" | "slugIndex">> = {},
): Promise<AdminTestContext> => {
  const event = await createTestEvent({
    maxAttendees: 100,
    thankYouUrl: "https://example.com",
    ...eventOverrides,
  });
  const attendee = await createTestAttendee(
    event.id,
    event.slug,
    "John Doe",
    "john@example.com",
  );
  const { cookie, csrfToken } = await getTestSession();
  return { event, attendee, cookie, csrfToken };
};

/**
 * Curried admin form POST for attendee actions.
 * Creates event + attendee + admin session, POSTs form to the attendee action URL.
 * csrf_token is auto-injected; include it in formData to override (e.g. "invalid-token").
 *
 *   const deleteAction = adminAttendeeAction("delete");
 *   const { response } = await deleteAction({ confirm_identifier: "John Doe" })();
 */
export const adminAttendeeAction =
  (action: string) =>
  (formData: Record<string, string> = {}) =>
  async (
    eventOverrides: Partial<Omit<EventInput, "slug" | "slugIndex">> = {},
  ): Promise<AdminTestContext & { response: Response }> => {
    const ctx = await setupAdminTest(eventOverrides);
    const { handleRequest } = await import("#routes");
    const response = await handleRequest(
      mockFormRequest(
        `/admin/event/${ctx.event.id}/attendee/${ctx.attendee.id}/${action}`,
        { csrf_token: ctx.csrfToken, ...formData },
        ctx.cookie,
      ),
    );
    return { ...ctx, response };
  };

/**
 * Curried admin GET for event pages with attendee setup.
 * Creates event + attendee + admin session, GETs the specified page.
 *
 *   const { response } = await adminEventPage(
 *     ctx => `/admin/event/${ctx.event.id}?checkin_status=in`,
 *   )();
 */
export const adminEventPage =
  (pathFn: (ctx: AdminTestContext) => string) =>
  async (
    eventOverrides: Partial<Omit<EventInput, "slug" | "slugIndex">> = {},
  ): Promise<AdminTestContext & { response: Response }> => {
    const ctx = await setupAdminTest(eventOverrides);
    const response = await awaitTestRequest(pathFn(ctx), {
      cookie: ctx.cookie,
    });
    return { ...ctx, response };
  };

/**
 * Create a manager user with a properly wrapped data key and return a session cookie.
 * Uses the admin user's data key (shared system key) wrapped with the new session token.
 * Must be called after createTestDbWithSetup().
 */
export const createTestManagerSession = async (
  token = "mgr-session",
  username = "testmanager",
): Promise<string> => {
  const { encrypt: enc } = await import("#lib/crypto/encryption.ts");
  const { hmacHash } = await import("#lib/crypto/hashing.ts");
  const { deriveKEK, unwrapKey, wrapKeyWithToken } = await import(
    "#lib/crypto/keys.ts"
  );
  const { getDb } = await import("#lib/db/client.ts");
  const { createSession } = await import("#lib/db/sessions.ts");
  const {
    getUserByUsername,
    verifyUserPassword,
    invalidateUsersCache: invalidateUsers,
  } = await import("#lib/db/users.ts");

  // Get the system DATA_KEY via the admin user (always exists after createTestDbWithSetup)
  const user = await getUserByUsername(TEST_ADMIN_USERNAME);
  if (!user) throw new Error("Admin user not found");
  const passwordHash = await verifyUserPassword(user, TEST_ADMIN_PASSWORD);
  if (!passwordHash) throw new Error("Admin password verification failed");
  const kek = await deriveKEK(passwordHash);
  if (!user.wrapped_data_key)
    throw new Error("Admin user has no wrapped data key");
  const dataKey = await unwrapKey(user.wrapped_data_key, kek);

  // Create manager user with a properly wrapped data key
  const managerIdx = await hmacHash(username);
  const managerWrappedKey = await wrapKeyWithToken(
    dataKey,
    "user-key-placeholder",
  );
  await getDb().execute({
    sql: `INSERT INTO users (username_hash, username_index, password_hash, wrapped_data_key, admin_level)
          VALUES (?, ?, ?, ?, ?)`,
    args: [
      await enc(username),
      managerIdx,
      "",
      managerWrappedKey,
      await enc("manager"),
    ],
  });
  invalidateUsers();

  // Find the manager user ID
  const result = await getDb().execute(
    "SELECT id FROM users ORDER BY id DESC LIMIT 1",
  );
  const userId = (result.rows[0] as Row).id as number;

  // Create session with properly wrapped data key
  const wrappedDataKey = await wrapKeyWithToken(dataKey, token);
  await createSession(
    token,
    "mgr-csrf",
    Date.now() + 60_000,
    wrappedDataKey,
    userId,
  );

  return `${getSessionCookieName()}=${token}`;
};

/**
 * Stub `stripePaymentProvider.verifyWebhookSignature` to return a valid event.
 * Returns the stub (call `.restore()` in a `finally` block).
 */
export const stubWebhookVerify = async (eventData: {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}) => {
  const { stripePaymentProvider } = await import("#lib/stripe-provider.ts");
  return stub(stripePaymentProvider, "verifyWebhookSignature", () =>
    Promise.resolve({ valid: true as const, event: eventData }),
  );
};

/** Pre-built test certificates for Apple Wallet PKCS#7 signing.
 *  Generated once at module load since RSA-2048 keygen in pure JS is slow (~5s per keypair).
 *  Safe because #test-utils is only imported by test files, and Deno loads it once per process. */
const _testCerts: SigningCredentials = (() => {
  const keys = forge.pki.rsa.generateKeyPair(2048);

  // Create a CA cert (WWDR stand-in)
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = keys.publicKey;
  caCert.serialNumber = "01";
  caCert.validity.notBefore = new Date();
  caCert.validity.notAfter = new Date();
  caCert.validity.notAfter.setFullYear(
    caCert.validity.notAfter.getFullYear() + 1,
  );
  const caAttrs = [{ name: "commonName", value: "Test WWDR CA" }];
  caCert.setSubject(caAttrs);
  caCert.setIssuer(caAttrs);
  caCert.setExtensions([{ name: "basicConstraints", cA: true }]);
  caCert.sign(keys.privateKey, forge.md.sha256.create());

  // Create a signing cert
  const signingKeys = forge.pki.rsa.generateKeyPair(2048);
  const signingCert = forge.pki.createCertificate();
  signingCert.publicKey = signingKeys.publicKey;
  signingCert.serialNumber = "02";
  signingCert.validity.notBefore = new Date();
  signingCert.validity.notAfter = new Date();
  signingCert.validity.notAfter.setFullYear(
    signingCert.validity.notAfter.getFullYear() + 1,
  );
  signingCert.setSubject([{ name: "commonName", value: "Test Pass Signing" }]);
  signingCert.setIssuer(caAttrs);
  signingCert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    passTypeId: "pass.com.test.tickets",
    teamId: "TESTTEAM01",
    signingCert: forge.pki.certificateToPem(signingCert),
    signingKey: forge.pki.privateKeyToPem(signingKeys.privateKey),
    wwdrCert: forge.pki.certificateToPem(caCert),
  };
})();

/** Return pre-built test certificates for Apple Wallet signing */
export const generateTestCerts = (): SigningCredentials => _testCerts;

/** Pre-generate Google Wallet test credentials (PKCS8 RSA key, synchronous) */
const _googleTestCreds: GoogleWalletCredentials = (() => {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const pkcs8Asn1 = forge.pki.wrapRsaPrivateKey(
    forge.pki.privateKeyToAsn1(keys.privateKey),
  );
  const pem = forge.pki.privateKeyInfoToPem(pkcs8Asn1);
  return {
    issuerId: "1234567890",
    serviceAccountEmail: "test@test-project.iam.gserviceaccount.com",
    serviceAccountKey: pem,
  };
})();

/** Return pre-built Google Wallet test credentials */
export const generateGoogleTestCreds = (): GoogleWalletCredentials =>
  _googleTestCreds;

// ---------------------------------------------------------------------------
// Email / Webhook test factories
// ---------------------------------------------------------------------------

import type { EmailEntry, EmailEvent } from "#lib/email.ts";
import type { WebhookAttendee } from "#lib/webhook.ts";

export type { EmailEntry, EmailEvent, WebhookAttendee };

/**
 * Create a daily event and an attendee with a booked date.
 * Returns the event, attendee, and ticket token.
 */
export const createDailyTestAttendee = async (
  name: string,
  email: string,
  date: string,
  eventOverrides: Partial<Omit<EventInput, "slug" | "slugIndex">> = {},
): Promise<{ event: Event; attendee: Attendee; token: string }> => {
  const { createAttendeeAtomic } = await import("#lib/db/attendees.ts");
  const event = await createDailyTestEvent({
    maxAttendees: 10,
    maximumDaysAfter: 30,
    ...eventOverrides,
  });
  const result = await createAttendeeAtomic({
    name,
    email,
    bookings: [{ eventId: event.id, date }],
  });
  const { attendees } = result as Extract<typeof result, { success: true }>;
  const attendee = attendees[0]!;
  return { event, attendee, token: attendee.ticket_token };
};

/** Build an EmailEvent with sensible defaults */
export const makeTestEvent = (
  overrides: Partial<EmailEvent> = {},
): EmailEvent => ({
  id: 1,
  name: "Test Event",
  slug: "test-event",
  webhook_url: "",
  max_attendees: 100,
  attendee_count: 10,
  unit_price: 0,
  can_pay_more: false,
  date: "",
  location: "",
  purchase_only: false,
  ...overrides,
});

/** Build a WebhookAttendee with sensible defaults */
export const makeTestAttendee = (
  overrides: Partial<WebhookAttendee> = {},
): WebhookAttendee => ({
  id: 42,
  quantity: 1,
  name: "Jane Doe",
  email: "jane@example.com",
  phone: "555-1234",
  address: "",
  special_instructions: "",
  payment_id: "",
  price_paid: "0",
  ticket_token: "AABB001122",
  date: null,
  ...overrides,
});

/** Build an EmailEntry from event/attendee overrides */
export const makeTestEntry = (
  eventOverrides?: Partial<EmailEvent>,
  attendeeOverrides?: Partial<WebhookAttendee>,
): EmailEntry => ({
  event: makeTestEvent(eventOverrides),
  attendee: makeTestAttendee(attendeeOverrides),
});

// ---------------------------------------------------------------------------
// Storage mock helpers — shared across image, attachment, and CDN tests
// ---------------------------------------------------------------------------

/** JPEG magic bytes for a valid test image */
export const JPEG_HEADER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

/** PDF magic bytes for test attachments / invalid-image-type tests */
export const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

/** Standard CDN 201 success response (null body avoids ReadableStream leaks
 *  when the Bunny SDK doesn't consume the response body after upload/remove) */
export const cdnOkResponse = (): Response =>
  new Response(null, { status: 201 });

/** Mock fetch to intercept Bunny CDN API calls, forwarding others to real fetch */
export const withStorageMock = (
  fn: (fetchCalls: string[]) => Promise<void>,
): Promise<void> =>
  runWithStorageConfig({ zoneName: "testzone", zoneKey: "testkey" }, () =>
    withFetchMock(async (originalFetch) => {
      const fetchCalls: string[] = [];
      installUrlHandler(originalFetch, (url) => {
        fetchCalls.push(url);
        if (url.includes("storage.bunnycdn.com") || url.includes("b-cdn.net")) {
          return Promise.resolve(cdnOkResponse());
        }
        return null;
      });
      await fn(fetchCalls);
    }),
  );

/** Mock fetch where CDN requests return a fixed response, others pass through */
export const withCdnProxy = (
  respond: () => Response,
  fn: () => Promise<void>,
): Promise<void> =>
  runWithStorageConfig({ zoneName: "testzone", zoneKey: "testkey" }, () =>
    withFetchMock(async (originalFetch) => {
      installUrlHandler(originalFetch, (url) =>
        url.includes("storage.bunnycdn.com")
          ? Promise.resolve(respond())
          : null,
      );
      await fn();
    }),
  );

/**
 * Run a callback with storage explicitly disabled (neither Bunny nor local).
 * Uses AsyncLocalStorage so concurrent tests cannot interfere.
 */
export const withStorageDisabled = <T>(fn: () => T): T =>
  runWithStorageConfig({ zoneName: "", zoneKey: "", localPath: "" }, fn);

/**
 * Run a callback with storage explicitly enabled (testzone/testkey via Bunny).
 * Uses AsyncLocalStorage so concurrent tests cannot interfere.
 */
export const withStorageEnabled = <T>(fn: () => T): T =>
  runWithStorageConfig({ zoneName: "testzone", zoneKey: "testkey" }, fn);

/**
 * Run a callback with local filesystem storage enabled at a temporary directory.
 * Uses AsyncLocalStorage so concurrent tests cannot interfere.
 */
export const withLocalStorageEnabled = async <T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> => {
  const dir = await Deno.makeTempDir();
  try {
    return await runWithStorageConfig(
      { zoneName: "", zoneKey: "", localPath: dir },
      () => fn(dir),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

// ---------------------------------------------------------------------------
// API key helpers — shared across admin API and API key tests
// ---------------------------------------------------------------------------

/** Get the DATA_KEY from the test session */
export const getTestDataKey = async (): Promise<CryptoKey> => {
  const cookie = await testCookie();
  const sessionMatch = cookie.match(
    new RegExp(`${getSessionCookieName()}=([^;]+)`),
  );
  const token = sessionMatch![1]!;
  const session = await getSession(token);
  return unwrapKeyWithToken(session!.wrapped_data_key!, token);
};

/** Create an API key and return its token */
export const createTestApiKeyToken = async (): Promise<string> => {
  const dataKey = await getTestDataKey();
  const { apiKey } = await createApiKey(
    1,
    "Test API Key",
    dataKey,
    generateSecureToken,
  );
  return apiKey;
};

/** Create an API key and return { apiKey, id, dataKey } */
export const createTestApiKeyFull = async (
  name = "Test Key",
): Promise<{ apiKey: string; id: number; dataKey: CryptoKey }> => {
  const dataKey = await getTestDataKey();
  const { apiKey, id } = await createApiKey(
    1,
    name,
    dataKey,
    generateSecureToken,
  );
  return { apiKey, id, dataKey };
};

/** Create a mock request authenticated with an API key Bearer token */
export const requestAsApiKey = (
  path: string,
  apiKey: string,
  opts: RequestInit = {},
): Request => {
  const headers = new Headers(opts.headers);
  headers.set("authorization", `Bearer ${apiKey}`);
  if (!headers.has("host")) headers.set("host", "localhost");
  return new Request(`http://localhost${path}`, { ...opts, headers });
};

/** Create a mock request authenticated with a session cookie + CSRF token */
export const requestAsSession = (
  path: string,
  session: { cookie: string; csrfToken: string },
  opts: RequestInit = {},
): Request => {
  const headers = new Headers(opts.headers);
  headers.set("cookie", session.cookie);
  headers.set("x-csrf-token", session.csrfToken);
  if (!headers.has("host")) headers.set("host", "localhost");
  return new Request(`http://localhost${path}`, { ...opts, headers });
};

/** Make an authenticated JSON API request using an API key (or auto-creating one) */
export const apiRequest = async (
  path: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
    apiKey?: string;
  } = {},
): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  const apiKey = options.apiKey ?? (await createTestApiKeyToken());
  const method = options.method ?? "GET";
  const headers: HeadersInit =
    method !== "GET" ? { "content-type": "application/json" } : {};
  const init: RequestInit = {
    method,
    headers,
    body: method !== "GET" ? JSON.stringify(options.body ?? {}) : undefined,
  };
  return handleRequest(requestAsApiKey(path, apiKey, init));
};

export { TestBrowser } from "#test-utils/test-browser.ts";
