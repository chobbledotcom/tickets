import type { InValue } from "@libsql/client";
import type { WrappedKey } from "#crypto/sealed.ts";
import { generateSecureToken } from "#crypto/utils.ts";
import { createApiKey } from "#db/api-keys.ts";
import { getSession } from "#db/sessions.ts";
import type { AuthSession } from "#routes/auth.ts";
import { getSessionCookieName } from "#shared/cookies.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  runWithSessionContext,
  setCachedSession,
} from "#shared/session-context.ts";
import type { TestListingOverrides } from "#test-utils/factories.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";
import {
  type AdminTestContext,
  getInternalTestSession,
  setTestSession,
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
} from "#test-utils/internal.ts";
import { getSetupState } from "#test-utils/test-state.ts";
import type { Listing } from "#types";

export const loginAsAdmin = async (
  username: string = TEST_ADMIN_USERNAME,
  password: string = TEST_ADMIN_PASSWORD,
): Promise<{
  cookie: string;
  csrfToken: string;
}> => {
  const { mockAdminLoginRequest, sendToApp, testPageHtml } = await import(
    "#test-utils/mocks.ts"
  );
  const { extractCsrfToken } = await import("#test-utils/csrf.ts");

  const loginCsrfToken = extractCsrfToken(await testPageHtml("/admin/"));

  if (!loginCsrfToken) {
    throw new Error("Failed to get CSRF token for admin login");
  }

  const loginResponse = await sendToApp(
    await mockAdminLoginRequest({ password, username }, loginCsrfToken),
  );
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

  const cached = getSetupState()?.session;
  if (cached) {
    const { getDb, insert } = await import("#db/client.ts");
    await getDb().execute(insert("sessions", cached.sessionRow));
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
export const getTestAuthSession = async (): Promise<AuthSession> => {
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

/** Insert a user row and open a live session for it. The role helpers below
 * differ only in the row they store and the key the session carries. */
const createUserWithSession = async (
  username: string,
  row: Record<string, InValue>,
  session: {
    token: string;
    csrfToken: string;
    wrappedKey: WrappedKey | null;
  },
): Promise<number> => {
  const { getDb, insert } = await import("#db/client.ts");
  const { createSession } = await import("#db/sessions.ts");
  const { getUserByUsername, invalidateUsersCache: invalidateUsers } =
    await import("#db/users.ts");
  await getDb().execute(insert("users", row));
  invalidateUsers();
  const userId = (await getUserByUsername(username))!.id;
  await createSession(
    session.token,
    session.csrfToken,
    Date.now() + 60_000,
    session.wrappedKey,
    userId,
  );
  return userId;
};

export const createTestManagerSession = async (
  token = "mgr-session",
  username = "testmanager",
): Promise<string> => {
  const { encrypt: enc } = await import("#crypto/encryption.ts");
  const { hmacHash } = await import("#crypto/hashing.ts");
  const { wrapKeyWithToken } = await import("#crypto/keys.ts");
  const { getOwnerDataKey } = await import("#test-utils/owner-key.ts");

  const dataKey = await getOwnerDataKey();
  await createUserWithSession(
    username,
    {
      admin_level: await enc("manager"),
      password_hash: "",
      username_hash: await enc(username),
      username_index: await hmacHash(username),
      wrapped_data_key: await wrapKeyWithToken(dataKey, "user-key-placeholder"),
    },
    {
      csrfToken: "mgr-csrf",
      token,
      wrappedKey: await wrapKeyWithToken(dataKey, token),
    },
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
  const { encrypt: enc } = await import("#crypto/encryption.ts");
  const { hashPassword, hmacHash } = await import("#crypto/hashing.ts");
  const { deriveKEK, wrapKey, wrapKeyWithToken } = await import(
    "#crypto/keys.ts"
  );
  const { getOwnerDataKey } = await import("#test-utils/owner-key.ts");

  const dataKey = await getOwnerDataKey();

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

  const userId = await createUserWithSession(
    username,
    {
      admin_level: await enc("agent"),
      password_hash: passwordHashEnc,
      username_hash: await enc(username),
      username_index: await hmacHash(username),
      wrapped_data_key: userWrappedKey,
    },
    {
      csrfToken: "agent-csrf",
      token,
      wrappedKey: await wrapKeyWithToken(dataKey, token),
    },
  );

  if (opts.agentIds && opts.agentIds.length > 0) {
    const { userAgents } = await import("#db/user-agents.ts");
    await userAgents.setIds(userId, opts.agentIds);
  }

  return { cookie: `${getSessionCookieName()}=${token}`, userId };
};

/**
 * Create an activated **editor** user plus a live session for it. Editors hold
 * no DATA_KEY, so — unlike every other role helper — both the user row's
 * `wrapped_data_key` and the session's wrapped key are null. The user has a
 * password set (so it counts as activated) but it protects no key. Mirrors the
 * real keyless editor a /join activation produces.
 */
export const createTestEditorSession = async (
  opts: { token?: string; username?: string; password?: string } = {},
): Promise<{ cookie: string; userId: number }> => {
  const token = opts.token ?? "editor-session";
  // Production stores usernames lower-cased (buildUserInsert), so the login
  // blind-index lookup is case-insensitive; mirror that here.
  const username = (opts.username ?? "testeditor").toLowerCase();
  const password = opts.password ?? "editorpass123";
  const { encrypt: enc } = await import("#crypto/encryption.ts");
  const { hashPassword, hmacHash } = await import("#crypto/hashing.ts");

  const userId = await createUserWithSession(
    username,
    {
      admin_level: await enc("editor"),
      kek_version: 2,
      password_hash: await enc(await hashPassword(password)),
      username_hash: await enc(username),
      username_index: await hmacHash(username),
      wrapped_data_key: null,
    },
    { csrfToken: "editor-csrf", token, wrappedKey: null },
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
  const { getTestDataKey } = await import("#test-utils/crypto.ts");
  return getTestDataKey();
};

/** A request to `path` carrying the headers that say who is asking, plus the
 * host header the app needs. */
const requestWithProof = (
  proof: Record<string, string>,
  path: string,
  opts: RequestInit,
): Request => {
  const headers = new Headers(opts.headers);
  for (const [name, value] of Object.entries(proof)) headers.set(name, value);
  if (!headers.has("host")) headers.set("host", "localhost");
  return new Request(`http://localhost${path}`, { ...opts, headers });
};

export const requestAsApiKey = (
  path: string,
  apiKey: string,
  opts: RequestInit = {},
): Request =>
  requestWithProof({ authorization: `Bearer ${apiKey}` }, path, opts);

export const requestAsSession = (
  path: string,
  session: { cookie: string; csrfToken: string },
  opts: RequestInit = {},
): Request =>
  requestWithProof(
    { cookie: session.cookie, "x-csrf-token": session.csrfToken },
    path,
    opts,
  );

export const apiRequest = async (
  path: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
    apiKey?: string;
  } = {},
): Promise<Response> => {
  const { sendToApp } = await import("#test-utils/mocks.ts");
  const apiKey = options.apiKey ?? (await createTestApiKeyToken());
  const method = options.method ?? "GET";
  const headers: HeadersInit =
    method !== "GET" ? { "content-type": "application/json" } : {};
  const init: RequestInit = {
    ...(method !== "GET" ? { body: JSON.stringify(options.body ?? {}) } : {}),
    headers,
    method,
  };
  return sendToApp(requestAsApiKey(path, apiKey, init));
};

export const setupListingAndLogin = async (
  overrides?: TestListingOverrides,
): Promise<{
  listing: Listing;
  cookie: string;
  csrfToken: string;
}> => {
  const { createTestListing } = await import(
    "#test-utils/db-helpers/listings.ts"
  );
  const listing = await createTestListing(overrides);
  const { cookie, csrfToken } = await getTestSession();
  return { cookie, csrfToken, listing };
};

export const adminFormPost = async (
  path: string,
  data: TestFormValues = {},
): Promise<{ response: Response; cookie: string; csrfToken: string }> => {
  const { settings } = await import("#db/settings.ts");
  await settings.loadKeys([]);
  const { cookie, csrfToken } = await getTestSession();
  const { awaitTestRequest } = await import("#test-utils/mocks.ts");
  const response = await awaitTestRequest(path, {
    cookie,
    data: {
      csrf_token: csrfToken,
      settings_version: String(settings.version),
      ...data,
    },
  });
  return { cookie, csrfToken, response };
};

export const adminMultipartPost = async (
  path: string,
  data: TestFormValues = {},
  file?: {
    name: string;
    fieldName: string;
    data: Uint8Array;
    contentType: string;
  },
): Promise<{ response: Response; cookie: string; csrfToken: string }> => {
  const { cookie, csrfToken } = await getTestSession();
  const { mockMultipartRequest, sendToApp } = await import(
    "#test-utils/mocks.ts"
  );
  const response = await sendToApp(
    mockMultipartRequest(
      path,
      { csrf_token: csrfToken, ...data },
      cookie,
      file,
    ),
  );
  return { cookie, csrfToken, response };
};

export const adminGet = async (path: string): Promise<Response> => {
  const { cookie } = await getTestSession();
  const { awaitTestRequest } = await import("#test-utils/mocks.ts");
  return awaitTestRequest(path, { cookie });
};

/** Curried helper for bulk-action GET pages: returns a function that fetches
 *  `/admin/groups/:id/bulk-actions/<action>`, asserts 200, and returns the
 *  HTML body. The two concrete actions (duplicate, deactivate) share this
 *  structure — curry with the action name to create each specialisation. */
export const getBulkActionForm =
  (action: string) =>
  async (groupId: number): Promise<string> => {
    const { expect } = await import("@std/expect");
    const response = await adminGet(
      `/admin/groups/${groupId}/bulk-actions/${action}`,
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    return html;
  };

export const setupAdminTest = async (
  listingOverrides: TestListingOverrides = {},
): Promise<AdminTestContext> => {
  const { createTestListing } = await import(
    "#test-utils/db-helpers/listings.ts"
  );
  const { createTestAttendee } = await import(
    "#test-utils/db-helpers/attendees.ts"
  );
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

type AdminFixtureResult = AdminTestContext & { response: Response };

/** Set up the standard admin fixture, send one request built from it, and
 * hand back the fixture together with the response. */
const onAdminFixture =
  (send: (ctx: AdminTestContext) => Promise<Response>) =>
  async (
    listingOverrides: TestListingOverrides = {},
  ): Promise<AdminFixtureResult> => {
    const ctx = await setupAdminTest(listingOverrides);
    return { ...ctx, response: await send(ctx) };
  };

export const adminAttendeeAction =
  (action: string, scope: "listing" | "attendee" = "attendee") =>
  (
    formData: Record<string, string> = {},
  ): ((
    listingOverrides?: TestListingOverrides,
  ) => Promise<AdminFixtureResult>) =>
    onAdminFixture(async (ctx) => {
      const { awaitTestRequest } = await import("#test-utils/mocks.ts");
      const url =
        scope === "listing"
          ? `/admin/listing/${ctx.listing.id}/attendee/${ctx.attendee.id}/${action}`
          : `/admin/attendees/${ctx.attendee.id}/${action}`;
      return awaitTestRequest(url, {
        cookie: ctx.cookie,
        data: { csrf_token: ctx.csrfToken, ...formData },
      });
    });

export const adminListingPage = (
  pathFn: (ctx: AdminTestContext) => string,
): ((listingOverrides?: TestListingOverrides) => Promise<AdminFixtureResult>) =>
  onAdminFixture(async (ctx) => {
    const { awaitTestRequest } = await import("#test-utils/mocks.ts");
    return awaitTestRequest(pathFn(ctx), { cookie: ctx.cookie });
  });
