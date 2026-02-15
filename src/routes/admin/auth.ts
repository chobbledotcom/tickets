/**
 * Admin authentication routes - login and logout
 */

import { deriveKEK, unwrapKey, wrapKeyWithToken } from "#lib/crypto.ts";
import {
  clearLoginAttempts,
  isLoginRateLimited,
  recordFailedLogin,
} from "#lib/db/login-attempts.ts";
import { createSession, deleteSession } from "#lib/db/sessions.ts";
import { getUserByUsername, verifyUserPassword } from "#lib/db/users.ts";
import { validateForm } from "#lib/forms.tsx";
import { nowMs } from "#lib/now.ts";
import { loginResponse } from "#routes/admin/dashboard.ts";
import { clearSessionCookie } from "#routes/admin/utils.ts";
import { defineRoutes } from "#routes/router.ts";
import type { ServerContext } from "#routes/types.ts";
import {
  generateSecureToken,
  getClientIp,
  parseFormData,
  redirect,
  requireCsrfForm,
  validateCsrfToken,
  withSession,
} from "#routes/utils.ts";
import { loginFields, type LoginFormValues } from "#templates/fields.ts";
import { getEnv } from "#lib/env.ts";

/** Random delay between 100-200ms to prevent timing attacks */
const randomDelay = (): Promise<void> =>
  getEnv("TEST_SKIP_LOGIN_DELAY")
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 100));

const ADMIN_LOGIN_CSRF_COOKIE = "__Host-admin_login_csrf";

const invalidLoginCsrfResponse = (newToken: string, status = 403): Response =>
  loginResponse(newToken, "Invalid or expired form", status);

const invalidCredentialsResponse = (newToken: string): Response =>
  loginResponse(newToken, "Invalid credentials", 401);

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

  return redirect(
    "/admin",
    `__Host-session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`,
  );
};

/**
 * Handle POST /admin/login
 */
const handleAdminLogin = async (
  request: Request,
  server?: ServerContext,
): Promise<Response> => {
  await randomDelay();

  const clientIp = getClientIp(request, server);

  // Check rate limiting
  if (await isLoginRateLimited(clientIp)) {
    return loginResponse(
      generateSecureToken(),
      "Too many login attempts. Please try again later.",
      429,
    );
  }

  const csrf = await requireCsrfForm(
    request,
    (newToken) => invalidLoginCsrfResponse(newToken),
    ADMIN_LOGIN_CSRF_COOKIE,
  );
  if (!csrf.ok) return csrf.response;

  const { form } = csrf;
  const validation = validateForm<LoginFormValues>(form, loginFields);

  if (!validation.valid) {
    return loginResponse(generateSecureToken(), validation.error, 400);
  }

  const { username, password } = validation.values;

  // Look up user by username
  const user = await getUserByUsername(username);
  if (!user) {
    await recordFailedLogin(clientIp);
    return invalidCredentialsResponse(generateSecureToken());
  }

  // Verify password (decrypt stored hash, then verify)
  const passwordHash = await verifyUserPassword(user, password);
  if (!passwordHash) {
    await recordFailedLogin(clientIp);
    return invalidCredentialsResponse(generateSecureToken());
  }

  // Clear failed attempts on successful login
  await clearLoginAttempts(clientIp);

  // Check if user has a wrapped data key (fully activated)
  if (!user.wrapped_data_key) {
    return loginResponse(
      generateSecureToken(),
      "Your account has not been activated yet. Please contact the site owner.",
      403,
    );
  }

  // Unwrap DATA_KEY using password-derived KEK
  const kek = await deriveKEK(passwordHash);
  let dataKey: CryptoKey;
  try {
    dataKey = await unwrapKey(user.wrapped_data_key, kek);
  } catch {
    // KEK mismatch - this shouldn't happen if password verification passed
    return invalidCredentialsResponse(generateSecureToken());
  }

  return createLoginSession(dataKey, user.id);
};

/**
 * Handle POST /admin/logout
 */
const handleAdminLogout = async (request: Request): Promise<Response> => {
  const form = await parseFormData(request);
  const csrfToken = String(form.get("csrf_token") ?? "");

  return withSession(
    request,
    async (session) => {
      if (!validateCsrfToken(session.csrfToken, csrfToken)) {
        return redirect("/admin", clearSessionCookie);
      }

      await deleteSession(session.token);
      return redirect("/admin", clearSessionCookie);
    },
    () => redirect("/admin", clearSessionCookie),
  );
};

/** Authentication routes */
export const authRoutes = defineRoutes({
  "GET /admin/login": () => loginResponse(generateSecureToken()),
  "POST /admin/login": (request, _, server) =>
    handleAdminLogin(request, server),
  "POST /admin/logout": (request) => handleAdminLogout(request),
});
