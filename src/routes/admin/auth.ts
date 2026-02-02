/**
 * Admin authentication routes - login and logout
 */

import { wrapKeyWithToken } from "#lib/crypto.ts";
import {
  clearLoginAttempts,
  isLoginRateLimited,
  recordFailedLogin,
} from "#lib/db/login-attempts.ts";
import { createSession, deleteSession } from "#lib/db/sessions.ts";
import { unwrapDataKey, verifyAdminPassword } from "#lib/db/settings.ts";
import { validateForm } from "#lib/forms.tsx";
import { ErrorCode, logError } from "#lib/logger.ts";
import { loginResponse } from "#routes/admin/dashboard.ts";
import { clearSessionCookie } from "#routes/admin/utils.ts";
import { defineRoutes } from "#routes/router.ts";
import type { ServerContext } from "#routes/types.ts";
import {
  generateSecureToken,
  getClientIp,
  parseFormData,
  redirect,
  withSession,
} from "#routes/utils.ts";
import { loginFields } from "#templates/fields.ts";

/** Random delay between 100-200ms to prevent timing attacks */
const randomDelay = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 100));

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
      "Too many login attempts. Please try again later.",
      429,
    );
  }

  const form = await parseFormData(request);
  const validation = validateForm(form, loginFields);

  if (!validation.valid) {
    return loginResponse(validation.error, 400);
  }

  const passwordHash = await verifyAdminPassword(
    validation.values.password as string,
  );
  if (!passwordHash) {
    await recordFailedLogin(clientIp);
    return loginResponse("Invalid credentials", 401);
  }

  // Clear failed attempts on successful login
  await clearLoginAttempts(clientIp);

  // Unwrap DATA_KEY using password-derived KEK
  const dataKey = await unwrapDataKey(passwordHash);
  if (!dataKey) {
    logError({ code: ErrorCode.KEY_DERIVATION, detail: "Login: wrapped_data_key missing or corrupt" });
    return loginResponse("System configuration error. Please contact support.", 500);
  }

  const token = generateSecureToken();
  const csrfToken = generateSecureToken();
  const expires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

  // Wrap DATA_KEY with session token for stateless access
  const wrappedDataKey = await wrapKeyWithToken(dataKey, token);

  await createSession(token, csrfToken, expires, wrappedDataKey);

  return redirect(
    "/admin",
    `__Host-session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`,
  );
};

/**
 * Handle GET /admin/logout
 */
const handleAdminLogout = (request: Request): Promise<Response> =>
  withSession(
    request,
    async (session) => {
      await deleteSession(session.token);
      return redirect("/admin", clearSessionCookie);
    },
    () => redirect("/admin", clearSessionCookie),
  );

/** Authentication routes */
export const authRoutes = defineRoutes({
  "POST /admin/login": (request, _, server) =>
    handleAdminLogin(request, server),
  "GET /admin/logout": (request) => handleAdminLogout(request),
});
