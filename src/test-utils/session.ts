import { getSessionCookieName } from "#lib/cookies.ts";
import type { Row } from "@libsql/client";
import { createApiKey } from "#lib/db/api-keys.ts";
import { wrapKeyWithToken } from "#lib/crypto/keys.ts";
import { generateSecureToken } from "#lib/crypto/utils.ts";
import { getSession } from "#lib/db/sessions.ts";
import { settings } from "#lib/db/settings.ts";
import { signCsrfToken } from "#lib/csrf.ts";
import type { Event, EventWithCount } from "#lib/types.ts";
import type { Attendee } from "#lib/types.ts";
import type { AdminTestContext } from "#test-utils/internal.ts";
import type { EventInput } from "#lib/db/events.ts";
import {
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
  getCachedAdminSession,
  getInternalTestSession,
  setTestSession,
} from "#test-utils/internal.ts";

export const loginAsAdmin = async (): Promise<{
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
      { password: TEST_ADMIN_PASSWORD, username: TEST_ADMIN_USERNAME },
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
    const { getDb } = await import("#lib/db/client.ts");
    const { insert } = await import("#lib/db/client.ts");
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

export const createTestManagerSession = async (
  token = "mgr-session",
  username = "testmanager",
): Promise<string> => {
  const { encrypt } = await import("#lib/crypto/encryption.ts");
  const { hmacHash } = await import("#lib/crypto/hashing.ts");
  const { deriveKEK, unwrapKey, wrapKeyWithToken } = await import(
    "#lib/crypto/keys.ts"
  );
  const { getDb } = await import("#lib/db/client.ts");
  const { insert } = await import("#lib/db/client.ts");
  const { createSession } = await import("#lib/db/sessions.ts");
  const {
    getUserByUsername,
    verifyUserPassword,
    invalidateUsersCache: invalidateUsers,
  } = await import("#lib/db/users.ts");

  const user = await getUserByUsername(TEST_ADMIN_USERNAME);
  if (!user) throw new Error("Admin user not found");
  const passwordHash = await verifyUserPassword(user, TEST_ADMIN_PASSWORD);
  if (!passwordHash) throw new Error("Admin password verification failed");
  const kek = await deriveKEK(passwordHash);
  if (!user.wrapped_data_key) {
    throw new Error("Admin user has no wrapped data key");
  }
  const dataKey = await unwrapKey(user.wrapped_data_key, kek);

  const managerIdx = await hmacHash(username);
  const managerWrappedKey = await wrapKeyWithToken(
    dataKey,
    "user-key-placeholder",
  );
  await getDb().execute(
    insert("users", {
      admin_level: await encrypt(username),
      password_hash: "",
      username_hash: await encrypt(username),
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
  return { apiKey, dataKey, id };
};

const getTestDataKey = async (): Promise<CryptoKey> => {
  const { unwrapKeyWithToken } = await import("#lib/crypto/keys.ts");
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

export const setupEventAndLogin = async (
  overrides?: Partial<Omit<EventInput, "slug" | "slugIndex">>,
): Promise<{
  event: Event;
  cookie: string;
  csrfToken: string;
}> => {
  const { createTestEvent } = await import("#test-utils/db-helpers.ts");
  const event = await createTestEvent(overrides);
  const { cookie, csrfToken } = await getTestSession();
  return { cookie, csrfToken, event };
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
  eventOverrides: Partial<Omit<EventInput, "slug" | "slugIndex">> = {},
): Promise<AdminTestContext> => {
  const { createTestEvent } = await import("#test-utils/db-helpers.ts");
  const { createTestAttendee } = await import("#test-utils/db-helpers.ts");
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
  return { attendee, cookie, csrfToken, event };
};

export const adminAttendeeAction =
  (action: string) =>
  (formData: Record<string, string> = {}) =>
  async (
    eventOverrides: Partial<Omit<EventInput, "slug" | "slugIndex">> = {},
  ): Promise<AdminTestContext & { response: Response }> => {
    const ctx = await setupAdminTest(eventOverrides);
    const { handleRequest } = await import("#routes");
    const { mockFormRequest } = await import("#test-utils/mocks.ts");
    const response = await handleRequest(
      mockFormRequest(
        `/admin/event/${ctx.event.id}/attendee/${ctx.attendee.id}/${action}`,
        { csrf_token: ctx.csrfToken, ...formData },
        ctx.cookie,
      ),
    );
    return { ...ctx, response };
  };

export const adminEventPage =
  (pathFn: (ctx: AdminTestContext) => string) =>
  async (
    eventOverrides: Partial<Omit<EventInput, "slug" | "slugIndex">> = {},
  ): Promise<AdminTestContext & { response: Response }> => {
    const ctx = await setupAdminTest(eventOverrides);
    const { awaitTestRequest } = await import("#test-utils/mocks.ts");
    const response = await awaitTestRequest(pathFn(ctx), {
      cookie: ctx.cookie,
    });
    return { ...ctx, response };
  };