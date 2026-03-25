/**
 * Admin authentication routes - login and logout
 */

import { lazyRef } from "#fp";
import { buildSessionCookie, clearSessionCookie } from "#lib/cookies.ts";
import { deriveKEK, unwrapKey, wrapKeyWithToken } from "#lib/crypto.ts";
import { verifySignedCsrfToken } from "#lib/csrf.ts";
import {
  clearLoginAttempts,
  isLoginRateLimited,
  recordFailedLogin,
} from "#lib/db/login-attempts.ts";
import { createSession, deleteSession } from "#lib/db/sessions.ts";
import { getUserByUsername, verifyUserPassword } from "#lib/db/users.ts";
import { getEnv } from "#lib/env.ts";
import { validateForm } from "#lib/forms.tsx";
import { nowMs } from "#lib/now.ts";
import { loginResponse } from "#routes/admin/dashboard.ts";
import { defineRoutes } from "#routes/router.ts";
import type { ServerContext } from "#routes/types.ts";
import {
  type FormParams,
  generateSecureToken,
  getAuthenticatedSession,
  getClientIp,
  parseFormData,
  redirect,
  withAuthForm,
} from "#routes/utils.ts";
import { type LoginFormValues, loginFields } from "#templates/fields.ts";

/** Whether to skip the login delay (for testing) */
const [getSkipLoginDelay, setSkipLoginDelay] = lazyRef(
  () => !!getEnv("TEST_SKIP_LOGIN_DELAY"),
);

/** Explicitly set the skip-login-delay flag (for testing without env var races) */
export const setSkipLoginDelayForTest = (skip: boolean): void =>
  setSkipLoginDelay(skip);

/** Random delay between 100-200ms to prevent timing attacks */
const randomDelay = (): Promise<void> =>
  getSkipLoginDelay()
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 100));

/** Create a session with a wrapped DATA_KEY and redirect to /admin */
const createLoginSession = async (
  dataKey: CryptoKey,
  userId: number,
): Promise<Response> => {
  const token = generateSecureToken();
  const csrfToken = generateSecureToken();
  const expires = nowMs() + 24 * 60 * 60 * 1000;
  const wrappedDataKey = await wrapKeyWithToken(dataKey, token);

  await createSession(token, csrfToken, expires, wrappedDataKey, userId);

  return redirect("/admin", "Logged in", true, {
    cookie: buildSessionCookie(token),
  });
};

/**
 * Handle POST /admin/login
 */
/** Validate CSRF token and rate limiting, returning error response if failed */
const validateLoginPrerequisites = async (
  form: FormParams,
  clientIp: string,
): Promise<Response | null> => {
  const csrfForm = form.getString("csrf_token");
  if (!csrfForm || !(await verifySignedCsrfToken(csrfForm))) {
    return loginResponse("Invalid or expired form. Please try again.", 403);
  }
  if (await isLoginRateLimited(clientIp)) {
    return loginResponse(
      "Too many login attempts. Please try again later.",
      429,
    );
  }
  return null;
};

/** Authenticate user credentials, returning the user and password hash or error */
const authenticateUser = async (
  username: string,
  password: string,
  clientIp: string,
): Promise<
  | {
      ok: true;
      user: Awaited<ReturnType<typeof getUserByUsername>> & object;
      passwordHash: string;
    }
  | { ok: false; response: Response }
> => {
  const failedResult = async () => {
    await recordFailedLogin(clientIp);
    return {
      ok: false as const,
      response: await loginResponse("Invalid credentials", 401),
    };
  };

  const user = await getUserByUsername(username);
  if (!user) return failedResult();

  const passwordHash = await verifyUserPassword(user, password);
  if (!passwordHash) return failedResult();

  return { ok: true, user, passwordHash };
};

const handleAdminLogin = async (
  request: Request,
  _params: Record<string, never>,
  server?: ServerContext,
): Promise<Response> => {
  await randomDelay();

  const form = await parseFormData(request);
  const clientIp = getClientIp(request, server);

  const prereqError = await validateLoginPrerequisites(form, clientIp);
  if (prereqError) return prereqError;

  const validation = validateForm<LoginFormValues>(form, loginFields);
  if (!validation.valid) return loginResponse(validation.error, 400);

  const auth = await authenticateUser(
    validation.values.username,
    validation.values.password,
    clientIp,
  );
  if (!auth.ok) return auth.response;

  const { user, passwordHash } = auth;
  await clearLoginAttempts(clientIp);

  if (!user.wrapped_data_key) {
    return loginResponse(
      "Your account has not been activated yet. Please contact the site owner.",
      403,
    );
  }

  const kek = await deriveKEK(passwordHash);
  let dataKey: CryptoKey;
  try {
    dataKey = await unwrapKey(user.wrapped_data_key, kek);
  } catch {
    return loginResponse("Invalid credentials", 401);
  }

  return createLoginSession(dataKey, user.id);
};

/**
 * Handle POST /admin/logout with CSRF validation
 */
const handleAdminLogout = (request: Request): Promise<Response> =>
  withAuthForm(request, async (session) => {
    await deleteSession(session.token);
    return redirect("/admin", "Logged out", true, {
      cookie: clearSessionCookie(),
    });
  });

/** Handle GET /admin/login - redirect to dashboard if already authenticated */
const handleLoginGet = async (request: Request): Promise<Response> => {
  const session = await getAuthenticatedSession(request);
  if (session) return redirect("/admin", "Already logged in", true);
  return loginResponse();
};

/** Authentication routes */
export const authRoutes = defineRoutes({
  "GET /admin/login": handleLoginGet,
  "POST /admin/login": handleAdminLogin,
  "POST /admin/logout": handleAdminLogout,
});
