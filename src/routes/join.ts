/**
 * Join routes - public invite acceptance flow
 */

import { createFormRoute } from "#lib/app-forms.ts";
import { signCsrfToken } from "#lib/csrf.ts";
import {
  decryptUsername,
  getUserByInviteCode,
  isInviteValid,
  setUserPassword,
} from "#lib/db/users.ts";
import { defineForm } from "#lib/forms.tsx";
import type { User } from "#lib/types.ts";
import { applyFlash } from "#routes/csrf.ts";
import { errorRedirect, htmlResponse, redirect } from "#routes/response.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import { joinCompletePage, joinErrorPage, joinPage } from "#templates/join.tsx";

export const joinForm = defineForm({
  fields: [
    {
      autocomplete: "new-password" as const,
      hint: "Minimum 8 characters",
      label: "Password",
      minlength: 8,
      name: "password" as const,
      required: true,
      type: "password" as const,
      validate: (v: string) =>
        v.length < 8 ? "Password must be at least 8 characters" : null,
    },
    {
      autocomplete: "new-password" as const,
      label: "Confirm Password",
      name: "password_confirm" as const,
      required: true,
      type: "password" as const,
    },
  ] as const,
  id: "join",
});

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

const setPasswordRoute = (code: string, user: User) =>
  createFormRoute({
    form: joinForm,
    onInvalid: ({ error }) => errorRedirect(`/join/${code}`, error),
    onValid: async ({ values }) => {
      if (values.password !== values.password_confirm) {
        return errorRedirect(`/join/${code}`, "Passwords do not match");
      }
      await setUserPassword(user.id, values.password);
      return redirect("/join/complete", "Password set successfully", true);
    },
  });

/**
 * Handle POST /join/:code
 */
const handleJoinPost = joinRoute(
  (request, code, user) => setPasswordRoute(code, user)(request, {}),
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
