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
  htmlResponse,
  parseCookies,
  parseFormData,
  redirect,
  validateCsrfToken,
  withAuthForm,
} from "#routes/utils.ts";
import { loginFields, type LoginFormValues } from "#templates/fields.ts";
import { getEnv } from "#lib/env.ts";

/** Cookie name for login CSRF token */
const LOGIN_CSRF_COOKIE = "__Host-admin_login_csrf";

/** Random delay between 100-200ms to prevent timing attacks */
const randomDelay = (): Promise<void> =>
  getEnv("TEST_SKIP_LOGIN_DELAY")
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

  const cookies = parseCookies(request);
  const form = await parseFormData(request);

  // Validate login CSRF token (double-submit cookie pattern)
  const csrfCookie = cookies.get(LOGIN_CSRF_COOKIE);
  const csrfForm = form.get("csrf_token");
  if (!csrfCookie || !csrfForm || !validateCsrfToken(csrfCookie, csrfForm)) {
    return loginResponse("Invalid or expired form. Please try again.", 403);
  }

  const clientIp = getClientIp(request, server);

  // Check rate limiting
  if (await isLoginRateLimited(clientIp)) {
    return loginResponse(
      "Too many login attempts. Please try again later.",
      429,
    );
  }

  const validation = validateForm<LoginFormValues>(form, loginFields);

  if (!validation.valid) {
    return loginResponse(validation.error, 400);
  }

  const { username, password } = validation.values;

  // Look up user by username
  const user = await getUserByUsername(username);
  if (!user) {
    await recordFailedLogin(clientIp);
    return loginResponse("Invalid credentials", 401);
  }

  // Verify password (decrypt stored hash, then verify)
  const passwordHash = await verifyUserPassword(user, password);
  if (!passwordHash) {
    await recordFailedLogin(clientIp);
    return loginResponse("Invalid credentials", 401);
  }

  // Clear failed attempts on successful login
  await clearLoginAttempts(clientIp);

  // Check if user has a wrapped data key (fully activated)
  if (!user.wrapped_data_key) {
    return loginResponse(
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
    return redirect("/admin", clearSessionCookie);
  });

/**
 * Handle GET /admin/logout - reject with error
 */
const handleAdminLogoutGet = (): Response =>
  htmlResponse("Method not allowed. Use POST to logout.", 405);

/** Authentication routes */
export const authRoutes = defineRoutes({
  "GET /admin/login": () => loginResponse(),
  "POST /admin/login": (request, _, server) =>
    handleAdminLogin(request, server),
  "GET /admin/logout": () => handleAdminLogoutGet(),
  "POST /admin/logout": (request) => handleAdminLogout(request),
});
