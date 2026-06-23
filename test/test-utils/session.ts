import type { Row } from "@libsql/client";
import type { AuthSession } from "#routes/auth.ts";
import { getSessionCookieName } from "#shared/cookies.ts";
import { generateSecureToken } from "#shared/crypto/utils.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { createApiKey } from "#shared/db/api-keys.ts";
import type { ListingInput } from "#shared/db/listings.ts";
import { getSession } from "#shared/db/sessions.ts";
import {
  runWithSessionContext,
  setCachedSession,
} from "#shared/session-context.ts";
import type { Listing } from "#shared/types.ts";
import type { AdminTestContext } from "#test-utils/internal.ts";
import {
  getCachedAdminSession,
  getInternalTestSession,
  setTestSession,
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
} from "#test-utils/internal.ts";

export const loginAsAdmin = async (
  username: string = TEST_ADMIN_USERNAME,
  password: string = TEST_ADMIN_PASSWORD,
): Promise<{
  cookie: string;
  csrfToken: string;
}> => {
  const { handleRequest } = await import("#routes");
  const { mockRequest, mockAdminLoginRequest } = await import(
    "#test-utils/mocks.ts"
  );
  const { extractCsrfToken } = await import("#test-utils/csrf.ts");

  const loginPageResponse = await handleRequest(mockRequest("/admin/"));
  const loginHtml = await loginPageResponse.text();
  const loginCsrfToken = extractCsrfToken(loginHtml);

  if (!loginCsrfToken) {
    throw new Error("Failed to get CSRF token for admin login");
  }

  const loginResponse = await handleRequest(
    await mockAdminLoginRequest(
      { password, username },
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

export const getTestSession = async (): Promise<{
  cookie: string;
  csrfToken: string;
}> => {
  const current = getInternalTestSession();
  if (current) return current;

  const cached = getCachedAdminSession();
  if (cached) {
    const { getDb } = await import("#shared/db/client.ts");
    const { insert } = await import("#shared/db/client.ts");
    await getDb().execute(
      insert("sessions", {
        csrf_token: cached.sessionRow.csrf_token,
        expires: cached.sessionRow.expires,
        token: cached.sessionRow.token,
        user_id: cached.sessionRow.user_id,
        wrapped_data_key: cached.sessionRow.wrapped_data_key,
      }),
    );
    const csrfToken = await signCsrfToken();
    const session = { cookie: cached.cookie, csrfToken };
    setTestSession(session);
    return session;
  }

  const session = await loginAsAdmin();
  setTestSession(session);
  return session;
};

export const testCookie = async (): Promise<string> =>
  (await getTestSession()).cookie;

export const testCsrfToken = async (): Promise<string> =>
  (await getTestSession()).csrfToken;

/** Build an owner AuthSession from the live test admin session row. */
const getTestAuthSession = async (): Promise<AuthSession> => {
  const cookie = await testCookie();
  const token = cookie.match(
    new RegExp(`${getSessionCookieName()}=([^;]+)`),
  )![1]!;
  const session = await getSession(token);
  if (!session) throw new Error("Test admin session row not found");
  return {
    adminLevel: "owner",
    token,
    userId: session.user_id!,
    wrappedDataKey: session.wrapped_data_key,
  };
};

/**
 * Run `fn` inside a request-scoped session context for the test admin owner,
 * mirroring the server's per-request `runWithSessionContext` wrapper. Use this
 * around direct calls to code that reads the private key from the current
 * request (e.g. activity-log decryption via `requireRequestPrivateKey`), which
 * otherwise has no session in scope in a unit test and fails closed.
 */
export const withTestSession = async <T>(fn: () => Promise<T>): Promise<T> => {
  const session = await getTestAuthSession();
  return runWithSessionContext(() => {
    setCachedSession(session);
    return fn();
  });
};

/**
 * Re-establish the cached test admin session after an action that logged the
 * owner out (e.g. a password change deletes existing sessions). Logs in fresh
 * with the given password and replaces the cached session, so subsequent
 * `withTestSession` / `getTestSession` calls resolve a valid session.
 */
export const reloginAsAdmin = async (
  password: string,
  username: string = TEST_ADMIN_USERNAME,
): Promise<void> => {
  setTestSession(await loginAsAdmin(username, password));
};

export const createTestManagerSession = async (
  token = "mgr-session",
  username = "testmanager",
): Promise<string> => {
  const { encrypt: enc } = await import("#shared/crypto/encryption.ts");
  const { hmacHash } = await import("#shared/crypto/hashing.ts");
  const { deriveKEKFromPassword, unwrapKey, wrapKeyWithToken } = await import(
    "#shared/crypto/keys.ts"
  );
  const { getDb } = await import("#shared/db/client.ts");
  const { insert } = await import("#shared/db/client.ts");
  const { createSession } = await import("#shared/db/sessions.ts");
  const {
    getUserByUsername,
    invalidateUsersCache: invalidateUsers,
    verifyUserPassword,
  } = await import("#shared/db/users.ts");

  // The owner is created at the v2 (password-bound) KEK scheme by setup; its KEK
  // is salted with the owner's stored password hash.
  const user = await getUserByUsername(TEST_ADMIN_USERNAME);
  if (!user?.wrapped_data_key) {
    throw new Error("Admin user has no wrapped data key");
  }
  const ownerHash = (await verifyUserPassword(user, TEST_ADMIN_PASSWORD))!;
  const kek = await deriveKEKFromPassword(TEST_ADMIN_PASSWORD, ownerHash);
  const dataKey = await unwrapKey(user.wrapped_data_key, kek);

  const managerIdx = await hmacHash(username);
  const managerWrappedKey = await wrapKeyWithToken(
    dataKey,
    "user-key-placeholder",
  );
  await getDb().execute(
    insert("users", {
      admin_level: await enc("manager"),
      password_hash: "",
      username_hash: await enc(username),
      username_index: managerIdx,
      wrapped_data_key: managerWrappedKey,
    }),
  );
  invalidateUsers();

  const result = await getDb().execute(
    "SELECT id FROM users ORDER BY id DESC LIMIT 1",
  );
  const userId = (result.rows[0] as Row).id as number;

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
 * Create a delivery-agent user that shares the test data key, plus a live
 * session for it. Returns the session cookie and the new user's id. When a
 * password is given the user's wrapped key is derived from it (so the real
 * login flow works); otherwise a placeholder wrapping is used. Optionally links
 * the user to logistics agents.
 */
export const createTestAgentSession = async (
  opts: {
    token?: string;
    username?: string;
    password?: string;
    agentIds?: number[];
  } = {},
): Promise<{ cookie: string; userId: number }> => {
  const token = opts.token ?? "agent-session";
  const username = opts.username ?? "testagent";
  const { encrypt: enc } = await import("#shared/crypto/encryption.ts");
  const { hashPassword, hmacHash } = await import("#shared/crypto/hashing.ts");
  const {
    deriveKEK,
    deriveKEKFromPassword,
    unwrapKey,
    wrapKey,
    wrapKeyWithToken,
  } = await import("#shared/crypto/keys.ts");
  const { getDb, insert } = await import("#shared/db/client.ts");
  const { createSession } = await import("#shared/db/sessions.ts");
  const {
    getUserByUsername,
    invalidateUsersCache: invalidateUsers,
    verifyUserPassword,
  } = await import("#shared/db/users.ts");

  // The owner is created at the v2 (password-bound) KEK scheme by setup; its KEK
  // is salted with the owner's stored password hash.
  const owner = await getUserByUsername(TEST_ADMIN_USERNAME);
  if (!owner?.wrapped_data_key) throw new Error("Admin user not set up");
  const ownerHash = (await verifyUserPassword(owner, TEST_ADMIN_PASSWORD))!;
  const dataKey = await unwrapKey(
    owner.wrapped_data_key,
    await deriveKEKFromPassword(TEST_ADMIN_PASSWORD, ownerHash),
  );

  // When given a password the agent is wrapped at the legacy v1 scheme with
  // kek_version defaulting to 1, so logging in as the agent exercises the
  // login-time v1→v2 migration.
  let passwordHashEnc = "";
  let userWrappedKey: string;
  if (opts.password) {
    const passwordHash = await hashPassword(opts.password);
    passwordHashEnc = await enc(passwordHash);
    userWrappedKey = await wrapKey(dataKey, await deriveKEK(passwordHash));
  } else {
    userWrappedKey = await wrapKeyWithToken(dataKey, "user-key-placeholder");
  }

  await getDb().execute(
    insert("users", {
      admin_level: await enc("agent"),
      password_hash: passwordHashEnc,
      username_hash: await enc(username),
      username_index: await hmacHash(username),
      wrapped_data_key: userWrappedKey,
    }),
  );
  invalidateUsers();
  const userId = (await getUserByUsername(username))!.id;

  if (opts.agentIds && opts.agentIds.length > 0) {
    const { setUserAgentIds } = await import("#shared/db/user-agents.ts");
    await setUserAgentIds(userId, opts.agentIds);
  }

  const wrappedDataKey = await wrapKeyWithToken(dataKey, token);
  await createSession(
    token,
    "agent-csrf",
    Date.now() + 60_000,
    wrappedDataKey,
    userId,
  );
  return { cookie: `${getSessionCookieName()}=${token}`, userId };
};

export const createTestApiKeyToken = async (): Promise<string> => {
  const dataKey = await getTestDataKeyForApiKey();
  const { apiKey } = await createApiKey(
    1,
    "Test API Key",
    dataKey,
    generateSecureToken,
  );
  return apiKey;
};

export const createTestApiKeyFull = async (
  name = "Test Key",
): Promise<{ apiKey: string; id: number; dataKey: CryptoKey }> => {
  const dataKey = await getTestDataKeyForApiKey();
  const { apiKey, id } = await createApiKey(
    1,
    name,
    dataKey,
    generateSecureToken,
  );
  return { apiKey, dataKey, id };
};

export const getTestDataKeyForApiKey = async (): Promise<CryptoKey> => {
  const { unwrapKeyWithToken } = await import("#shared/crypto/keys.ts");
  const cookie = await testCookie();
  const sessionMatch = cookie.match(
    new RegExp(`${getSessionCookieName()}=([^;]+)`),
  );
  const token = sessionMatch![1]!;
  const session = await getSession(token);
  return unwrapKeyWithToken(session!.wrapped_data_key!, token);
};

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
    body: method !== "GET" ? JSON.stringify(options.body ?? {}) : undefined,
    headers,
    method,
  };
  return handleRequest(requestAsApiKey(path, apiKey, init));
};

export const setupListingAndLogin = async (
  overrides?: Partial<Omit<ListingInput, "slug" | "slugIndex">>,
): Promise<{
  listing: Listing;
  cookie: string;
  csrfToken: string;
}> => {
  const { createTestListing } = await import("#test-utils/db-helpers.ts");
  const listing = await createTestListing(overrides);
  const { cookie, csrfToken } = await getTestSession();
  return { cookie, csrfToken, listing };
};

export const adminFormPost = async (
  path: string,
  data: Record<string, string> = {},
): Promise<{ response: Response; cookie: string; csrfToken: string }> => {
  const { cookie, csrfToken } = await getTestSession();
  const { handleRequest } = await import("#routes");
  const { mockFormRequest } = await import("#test-utils/mocks.ts");
  const response = await handleRequest(
    mockFormRequest(path, { csrf_token: csrfToken, ...data }, cookie),
  );
  return { cookie, csrfToken, response };
};

export const adminGet = async (
  path: string,
): Promise<{ response: Response; cookie: string; csrfToken: string }> => {
  const { cookie, csrfToken } = await getTestSession();
  const { awaitTestRequest } = await import("#test-utils/mocks.ts");
  const response = await awaitTestRequest(path, { cookie });
  return { cookie, csrfToken, response };
};

export const setupAdminTest = async (
  listingOverrides: Partial<Omit<ListingInput, "slug" | "slugIndex">> = {},
): Promise<AdminTestContext> => {
  const { createTestListing } = await import("#test-utils/db-helpers.ts");
  const { createTestAttendee } = await import("#test-utils/db-helpers.ts");
  const listing = await createTestListing({
    maxAttendees: 100,
    thankYouUrl: "https://example.com",
    ...listingOverrides,
  });
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    "John Doe",
    "john@example.com",
  );
  const { cookie, csrfToken } = await getTestSession();
  return { attendee, cookie, csrfToken, listing };
};

export const adminAttendeeAction =
  (action: string) =>
  (formData: Record<string, string> = {}) =>
  async (
    listingOverrides: Partial<Omit<ListingInput, "slug" | "slugIndex">> = {},
  ): Promise<AdminTestContext & { response: Response }> => {
    const ctx = await setupAdminTest(listingOverrides);
    const { handleRequest } = await import("#routes");
    const { mockFormRequest } = await import("#test-utils/mocks.ts");
    const response = await handleRequest(
      mockFormRequest(
        `/admin/listing/${ctx.listing.id}/attendee/${ctx.attendee.id}/${action}`,
        { csrf_token: ctx.csrfToken, ...formData },
        ctx.cookie,
      ),
    );
    return { ...ctx, response };
  };

export const adminListingPage =
  (pathFn: (ctx: AdminTestContext) => string) =>
  async (
    listingOverrides: Partial<Omit<ListingInput, "slug" | "slugIndex">> = {},
  ): Promise<AdminTestContext & { response: Response }> => {
    const ctx = await setupAdminTest(listingOverrides);
    const { awaitTestRequest } = await import("#test-utils/mocks.ts");
    const response = await awaitTestRequest(pathFn(ctx), {
      cookie: ctx.cookie,
    });
    return { ...ctx, response };
  };
