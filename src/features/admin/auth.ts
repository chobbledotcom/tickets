/**
 * Admin authentication routes - login and logout
 */

import { t } from "#i18n";
import { loginResponse } from "#routes/admin/dashboard.ts";
import {
  ANY_USER_FORM,
  adminLandingPath,
  anyUserPage,
  generateSecureToken,
  getAuthenticatedSession,
  withAuth,
} from "#routes/auth.ts";
import { parseFormData } from "#routes/csrf.ts";
import { redirect } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import type { ServerContext } from "#routes/types.ts";
import { getClientIp, parseCookies } from "#routes/url.ts";
import {
  buildSessionCookie,
  clearSessionCookie,
  getSessionCookieName,
} from "#shared/cookies.ts";
import {
  deriveKEK,
  deriveKEKFromPassword,
  unwrapKey,
  wrapKeyWithToken,
} from "#shared/crypto/keys.ts";
import { verifySignedCsrfToken } from "#shared/csrf.ts";
import {
  clearLoginAttempts,
  isLoginRateLimited,
  recordFailedLogin,
} from "#shared/db/login-attempts.ts";
import { createSession, deleteSession } from "#shared/db/sessions.ts";
import {
  decryptAdminLevel,
  getUserByUsername,
  migrateUserToV2Kek,
  verifyUserPassword,
} from "#shared/db/users.ts";
import { validateForm } from "#shared/forms.tsx";
import { nowMs } from "#shared/now.ts";
import { fail, ok } from "#shared/response.ts";
import { getSkipLoginDelay } from "#shared/test-overrides.ts";
import type { AdminLevel } from "#shared/types.ts";
import { adminLogoutPage } from "#templates/admin/logout.tsx";
import { getLoginFields, type LoginFormValues } from "#templates/fields.ts";

/** Random delay between 100-200ms to prevent timing attacks */
const randomDelay = (): Promise<void> =>
  getSkipLoginDelay()
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 100));

/** Create a session with a wrapped DATA_KEY and redirect to the user's landing
 * page (delivery agents go to their run sheet, staff to the dashboard). */
const createLoginSession = async (
  dataKey: CryptoKey,
  userId: number,
  adminLevel: AdminLevel,
): Promise<Response> => {
  const token = generateSecureToken();
  const csrfToken = generateSecureToken();
  const expires = nowMs() + 24 * 60 * 60 * 1000;
  const wrappedDataKey = await wrapKeyWithToken(dataKey, token);

  await createSession(token, csrfToken, expires, wrappedDataKey, userId);

  return redirect(adminLandingPath(adminLevel), "Logged in", true, {
    cookie: buildSessionCookie(token),
  });
};

/**
 * Handle POST /admin/login
 */
const handleAdminLogin = async (
  request: Request,
  _params: Record<string, never>,
  server?: ServerContext,
): Promise<Response> => {
  await randomDelay();

  const form = await parseFormData(request);

  // Validate login CSRF token (signed token pattern)
  const csrfForm = form.getString("csrf_token");
  if (!csrfForm || !(await verifySignedCsrfToken(csrfForm))) {
    return fail("/admin", t("error.csrf_invalid"));
  }

  const clientIp = getClientIp(request, server);

  // Check rate limiting
  if (await isLoginRateLimited(clientIp)) {
    return fail("/admin", t("error.too_many_attempts"));
  }

  // A failed credential check should also log the user out of any existing
  // session, so the redirect lands on the login page (not the dashboard).
  const existingToken = parseCookies(request).get(getSessionCookieName());
  const failedCredentialsRedirect = async (): Promise<Response> => {
    await recordFailedLogin(clientIp);
    if (existingToken) await deleteSession(existingToken);
    return fail("/admin", "Username or password was wrong", {
      cookie: existingToken ? clearSessionCookie() : undefined,
    });
  };

  const validation = validateForm<LoginFormValues>(form, getLoginFields());

  if (!validation.valid) {
    return fail("/admin", validation.error);
  }

  const { username, password } = validation.values;

  // Look up user by username
  const user = await getUserByUsername(username);
  if (!user) return failedCredentialsRedirect();

  // Verify password (decrypt stored hash, then verify)
  const passwordHash = await verifyUserPassword(user, password);
  if (!passwordHash) return failedCredentialsRedirect();

  // Clear failed attempts on successful login
  await clearLoginAttempts(clientIp);

  // Check if user has a wrapped data key (fully activated)
  if (!user.wrapped_data_key) {
    return fail("/admin", t("error.account_not_activated"));
  }

  // Unwrap DATA_KEY using the user's KEK scheme. v2 derives the KEK from the raw
  // password (so the wrap can't be reproduced from a DB dump); v1 (legacy)
  // derives it from the stored hash. A correct password is the only thing that
  // makes either unwrap succeed.
  let dataKey: CryptoKey;
  try {
    dataKey =
      user.kek_version >= 2
        ? await unwrapKey(
            user.wrapped_data_key,
            await deriveKEKFromPassword(password, passwordHash),
          )
        : await unwrapKey(user.wrapped_data_key, await deriveKEK(passwordHash));
  } catch {
    // KEK mismatch - this shouldn't happen if password verification passed
    return failedCredentialsRedirect();
  }

  // Upgrade a legacy wrap to the password-bound scheme now that we hold the raw
  // password — closes the DB-dump-recoverable path for this user going forward.
  if (user.kek_version < 2) {
    await migrateUserToV2Kek(user.id, dataKey, password, passwordHash);
  }

  const adminLevel = await decryptAdminLevel(user);
  return createLoginSession(dataKey, user.id, adminLevel);
};

/**
 * Handle POST /admin/logout with CSRF validation
 */
const handleAdminLogout = (request: Request): Promise<Response> =>
  withAuth(request, ANY_USER_FORM, async (session) => {
    await deleteSession(session.token);
    return ok("/admin", "Logged out", {
      cookie: clearSessionCookie(),
    });
  });

/** Handle GET /admin/login - redirect to dashboard if already authenticated */
const handleLoginGet = async (request: Request): Promise<Response> => {
  const session = await getAuthenticatedSession(request);
  if (session) {
    return ok(adminLandingPath(session.adminLevel), "Already logged in");
  }
  return loginResponse(request);
};

const handleLogoutGet = anyUserPage((session) => adminLogoutPage(session));

/** Authentication routes */
export const authRoutes = defineRoutes({
  "GET /admin/login": handleLoginGet,
  "GET /admin/logout": handleLogoutGet,
  "POST /admin/login": handleAdminLogin,
  "POST /admin/logout": handleAdminLogout,
});
