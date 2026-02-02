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
import {
  isLegacyAdmin,
  migrateLegacyAdmin,
  verifyLegacyPassword,
} from "#lib/db/settings.ts";
import { getUserByUsername, verifyUserPassword } from "#lib/db/users.ts";
import { validateForm } from "#lib/forms.tsx";
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

/** Create a session with a wrapped DATA_KEY and redirect to /admin */
const createLoginSession = async (
  dataKey: CryptoKey,
  userId: number,
): Promise<Response> => {
  const token = generateSecureToken();
  const csrfToken = generateSecureToken();
  const expires = Date.now() + 24 * 60 * 60 * 1000;
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
      "Too many login attempts. Please try again later.",
      429,
    );
  }

  const form = await parseFormData(request);
  const validation = validateForm(form, loginFields);

  if (!validation.valid) {
    return loginResponse(validation.error, 400);
  }

  const username = validation.values.username as string;
  const password = validation.values.password as string;

  // Check for legacy admin migration (single-admin installs without users table data)
  if (await isLegacyAdmin()) {
    return handleLegacyLogin(username, password, clientIp);
  }

  // Normal multi-user login: look up user by username
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
 * Handle login for legacy single-admin installs
 * Verifies password against settings, creates user row, migrates data
 */
const handleLegacyLogin = async (
  username: string,
  password: string,
  clientIp: string,
): Promise<Response> => {
  // Verify password against legacy settings
  const passwordHash = await verifyLegacyPassword(password);
  if (!passwordHash) {
    await recordFailedLogin(clientIp);
    return loginResponse("Invalid credentials", 401);
  }

  // Clear failed attempts on successful login
  await clearLoginAttempts(clientIp);

  // Migrate: create user row from legacy settings
  await migrateLegacyAdmin(username, passwordHash);

  // Now log in normally - look up the newly created user (guaranteed by migration)
  const user = (await getUserByUsername(username))!;

  // Unwrap DATA_KEY using password-derived KEK
  const kek = await deriveKEK(passwordHash);
  let dataKey: CryptoKey;
  try {
    dataKey = await unwrapKey(user.wrapped_data_key!, kek);
  } catch {
    return loginResponse("Invalid credentials", 401);
  }

  return createLoginSession(dataKey, user.id);
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
