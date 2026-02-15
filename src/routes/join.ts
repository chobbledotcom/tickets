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
import {
  csrfCookie,
  generateSecureToken,
  htmlResponse,
  htmlResponseWithCookie,
  redirect,
  requireCsrfForm,
} from "#routes/utils.ts";
import { joinFields, type JoinFormValues } from "#templates/fields.ts";
import {
  joinCompletePage,
  joinErrorPage,
  joinPage,
} from "#templates/join.tsx";

/** CSRF cookie name for join forms */
const JOIN_CSRF_COOKIE = "join_csrf";

/** Join CSRF cookie builder */
const joinCsrfCookie = (code: string, token: string): string =>
  csrfCookie(token, `/join/${code}`, JOIN_CSRF_COOKIE);

/** Join page response helper with CSRF cookie */
const joinResponse =
  (code: string, username: string) =>
  (token: string, error?: string, status = 200): Response =>
    htmlResponseWithCookie(joinCsrfCookie(code, token))(
      joinPage(code, username, error, token),
      status,
    );

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
  code: string,
  handler: (code: string, user: User, username: string) => Response | Promise<Response>,
): Promise<Response> => {
  const result = await validateInvite(code);
  return result instanceof Response ? result : handler(code, result.user, result.username);
};

/**
 * Handle GET /join/:code
 */
const handleJoinGet = (_request: Request, code: string): Promise<Response> =>
  withValidInvite(code, (code, _user, username) => {
    const csrfToken = generateSecureToken();
    return joinResponse(code, username)(csrfToken);
  });

/**
 * Handle POST /join/:code
 */
const handleJoinPost = (request: Request, code: string): Promise<Response> =>
  withValidInvite(code, async (code, user, username) => {
    const csrf = await requireCsrfForm(
      request,
      (newToken) =>
        joinResponse(code, username)(newToken, "Invalid or expired form. Please try again.", 403),
      JOIN_CSRF_COOKIE,
    );
    if (!csrf.ok) return csrf.response;

    const { form } = csrf;
    const formCsrf = form.get("csrf_token")!;

    // Validate password fields
    const validation = validateForm<JoinFormValues>(form, joinFields);
    if (!validation.valid) {
      return htmlResponse(joinPage(code, username, validation.error, formCsrf), 400);
    }

    const { password, password_confirm: passwordConfirm } = validation.values;

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

    return redirect("/join/complete");
  });

/**
 * Handle GET /join/complete - password set confirmation page
 */
const handleJoinComplete = (): Response =>
  htmlResponse(joinCompletePage());

/** Join routes */
const joinRoutes = defineRoutes({
  "GET /join/complete": () => handleJoinComplete(),
  "GET /join/:code": (request, { code }) => handleJoinGet(request, code),
  "POST /join/:code": (request, { code }) => handleJoinPost(request, code),
});

export const routeJoin = createRouter(joinRoutes);
