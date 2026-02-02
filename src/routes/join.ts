/**
 * Join routes - public invite acceptance flow
 */

import type { User } from "#lib/types.ts";
import {
  decryptUsername,
  getUserByInviteCode,
  isInviteValid,
  setUserPassword,
} from "#lib/db/users.ts";
import { validateForm } from "#lib/forms.tsx";
import { createRouter, defineRoutes } from "#routes/router.ts";
import type { RouteParams } from "#routes/router.ts";
import {
  generateSecureToken,
  htmlResponse,
  htmlResponseWithCookie,
  parseCookies,
  parseFormData,
  validateCsrfToken,
} from "#routes/utils.ts";
import { joinFields } from "#templates/fields.ts";
import {
  joinCompletePage,
  joinErrorPage,
  joinPage,
} from "#templates/join.tsx";

/** CSRF cookie for join form */
const joinCsrfCookie = (token: string, code: string): string =>
  `join_csrf=${token}; HttpOnly; Secure; SameSite=Strict; Path=/join/${code}; Max-Age=3600`;

/** Validate invite code and return user, or an error response */
const validateInvite = async (code: string): Promise<
  { user: User; username: string } | Response
> => {
  const user = await getUserByInviteCode(code);
  if (!user) {
    return htmlResponse(
      joinErrorPage("This invite link is invalid or has already been used."),
      404,
    );
  }

  const valid = await isInviteValid(user);
  if (!valid) {
    return htmlResponse(
      joinErrorPage("This invite link has expired."),
      410,
    );
  }

  return { user, username: await decryptUsername(user) };
};

/** Run handler with validated invite, returning error response if invalid */
const withValidInvite = async (
  params: RouteParams,
  handler: (code: string, user: User, username: string) => Response | Promise<Response>,
): Promise<Response> => {
  const code = params.code!;
  const result = await validateInvite(code);
  return result instanceof Response ? result : handler(code, result.user, result.username);
};

/**
 * Handle GET /join/:code
 */
const handleJoinGet = (_request: Request, params: RouteParams): Promise<Response> =>
  withValidInvite(params, (code, _user, username) => {
    const csrfToken = generateSecureToken();
    return htmlResponseWithCookie(joinCsrfCookie(csrfToken, code))(
      joinPage(code, username, undefined, csrfToken),
    );
  });

/**
 * Handle POST /join/:code
 */
const handleJoinPost = (request: Request, params: RouteParams): Promise<Response> =>
  withValidInvite(params, async (code, user, username) => {
    // Validate CSRF
    const cookies = parseCookies(request);
    const cookieCsrf = cookies.get("join_csrf") ?? "";
    const form = await parseFormData(request);
    const formCsrf = form.get("csrf_token") ?? "";

    if (!cookieCsrf || !formCsrf || !validateCsrfToken(cookieCsrf, formCsrf)) {
      const newCsrfToken = generateSecureToken();
      return htmlResponseWithCookie(joinCsrfCookie(newCsrfToken, code))(
        joinPage(code, username, "Invalid or expired form. Please try again.", newCsrfToken),
        403,
      );
    }

    // Validate password fields
    const validation = validateForm(form, joinFields);
    if (!validation.valid) {
      return htmlResponse(joinPage(code, username, validation.error, formCsrf), 400);
    }

    const password = validation.values.password as string;
    const passwordConfirm = validation.values.password_confirm as string;

    if (password.length < 8) {
      return htmlResponse(
        joinPage(code, username, "Password must be at least 8 characters", formCsrf),
        400,
      );
    }

    if (password !== passwordConfirm) {
      return htmlResponse(
        joinPage(code, username, "Passwords do not match", formCsrf),
        400,
      );
    }

    // Set the password and clear the invite code
    await setUserPassword(user.id, password);

    return htmlResponse(joinCompletePage());
  });

/** Join routes */
const joinRoutes = defineRoutes({
  "GET /join/:code": (request, params) => handleJoinGet(request, params),
  "POST /join/:code": (request, params) => handleJoinPost(request, params),
});

export const routeJoin = createRouter(joinRoutes);
