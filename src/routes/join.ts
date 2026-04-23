/**
 * Join routes - public invite acceptance flow
 */

import { signCsrfToken } from "#lib/csrf.ts";
import {
  decryptUsername,
  getUserByInviteCode,
  isInviteValid,
  setUserPassword,
} from "#lib/db/users.ts";
import { validateForm } from "#lib/forms.tsx";
import type { User } from "#lib/types.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import { applyFlash, withCsrfForm } from "#routes/csrf.ts";
import { errorRedirect, htmlResponse, redirect } from "#routes/response.ts";
import { type JoinFormValues, joinFields } from "#templates/fields.ts";
import { joinCompletePage, joinErrorPage, joinPage } from "#templates/join.tsx";

/** Validate invite code and return user, or an error response */
const validateInvite = async (
  code: string,
): Promise<{ user: User; username: string } | Response> => {
  const user = await getUserByInviteCode(code);
  if (!user) {
    return htmlResponse(
      joinErrorPage("This invite link is invalid or has already been used."),
      404,
    );
  }

  const valid = await isInviteValid(user);
  if (!valid) {
    return htmlResponse(joinErrorPage("This invite link has expired."), 410);
  }

  return { user, username: await decryptUsername(user) };
};

/** Run handler with validated invite, returning error response if invalid */
const withValidInvite = async (
  code: string,
  handler: (
    code: string,
    user: User,
    username: string,
  ) => Response | Promise<Response>,
): Promise<Response> => {
  const result = await validateInvite(code);
  return result instanceof Response
    ? result
    : handler(code, result.user, result.username);
};

/** Route params for invite code routes */
type InviteCodeParams = { code: string };

/** Create a join route handler that validates the invite code before running the callback */
const joinRoute =
  (
    handler: (
      request: Request,
      code: string,
      user: User,
      username: string,
    ) => Response | Promise<Response>,
  ) =>
  (request: Request, { code }: InviteCodeParams): Promise<Response> =>
    withValidInvite(code, (code, user, username) =>
      handler(request, code, user, username),
    );

/**
 * Handle GET /join/:code
 */
const handleJoinGet = joinRoute(async (request, code, _user, username) => {
  await signCsrfToken();
  const flash = applyFlash(request);
  return htmlResponse(joinPage(code, username, flash.error));
});

/**
 * Handle POST /join/:code
 */
const handleJoinPost = joinRoute((request, code, user, _username) =>
  withCsrfForm(
    request,
    (message) => errorRedirect(`/join/${code}`, message),
    async (form) => {
      // Validate password fields
      const validation = validateForm<JoinFormValues>(form, joinFields);
      if (!validation.valid) {
        return errorRedirect(`/join/${code}`, validation.error);
      }

      const { password, password_confirm: passwordConfirm } = validation.values;

      if (password.length < 8) {
        return errorRedirect(
          `/join/${code}`,
          "Password must be at least 8 characters",
        );
      }

      if (password !== passwordConfirm) {
        return errorRedirect(`/join/${code}`, "Passwords do not match");
      }

      // Set the password and clear the invite code
      await setUserPassword(user.id, password);

      return redirect("/join/complete", "Password set successfully", true);
    },
  ),
);

/**
 * Handle GET /join/complete - password set confirmation page
 */
const handleJoinComplete = (): Response => htmlResponse(joinCompletePage());

/** Join routes */
const joinRoutes = defineRoutes({
  "GET /join/:code": handleJoinGet,
  "GET /join/complete": handleJoinComplete,
  "POST /join/:code": handleJoinPost,
});

export const routeJoin = createRouter(joinRoutes);
