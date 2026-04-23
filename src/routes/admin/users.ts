/**
 * Admin user management routes - owner only
 */

import { getEffectiveDomain } from "#lib/config.ts";
import { unwrapKeyWithToken } from "#lib/crypto/keys.ts";
import { logActivity } from "#lib/db/activityLog.ts";
import {
  activateUser,
  createInvitedUser,
  decryptAdminLevel,
  decryptUsername,
  deleteUser,
  getAllUsers,
  getUserById,
  hashInviteCode,
  hasPassword,
  isInviteExpired,
  isUsernameTaken,
} from "#lib/db/users.ts";
import { getFlash } from "#lib/flash-context.ts";
import type { FormParams } from "#lib/form-data.ts";
import { validateForm } from "#lib/forms.tsx";
import { nowMs } from "#lib/now.ts";
import type { User } from "#lib/types.ts";
import { createConfirmedHandlers } from "#routes/admin/confirmation.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { type AuthSession, generateSecureToken, OWNER_FORM, ownerPage, requireOwnerOr, withAuth } from "#routes/auth.ts";
import { errorRedirect, htmlResponse, redirect } from "#routes/response.ts";
import { getSearchParam } from "#routes/url.ts";

import {
  adminUserDeletePage,
  adminUserNewPage,
  adminUsersPage,
  type DisplayUser,
  type UsersPageOpts,
} from "#templates/admin/users.tsx";
import {
  type InviteUserFormValues,
  inviteUserFields,
} from "#templates/fields.ts";

/** Invite link expiry: 7 days */
const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Valid admin levels */
const VALID_ADMIN_LEVELS = ["owner", "manager"] as const;

/**
 * Decrypt user data for display
 */
const toDisplayUser = async (user: User): Promise<DisplayUser> => {
  const userHasPassword = await hasPassword(user);
  return {
    adminLevel: await decryptAdminLevel(user),
    hasDataKey: user.wrapped_data_key !== null,
    hasPassword: userHasPassword,
    id: user.id,
    inviteExpired: userHasPassword ? false : await isInviteExpired(user),
    username: await decryptUsername(user),
  };
};

/**
 * Render users page with current state
 */
const renderUsersPage = async (
  session: AuthSession,
  opts: UsersPageOpts,
): Promise<string> => {
  const users = await getAllUsers();
  const displayUsers = await Promise.all(users.map(toDisplayUser));
  return adminUsersPage(displayUsers, session, opts);
};

/** Render users page with an error message and return an HTML response */
const usersErrorResponse = async (
  session: AuthSession,
  error: string,
  status: number,
): Promise<Response> =>
  htmlResponse(
    await renderUsersPage(session, {
      currentUserId: session.userId,
      error,
      inviteLink: "",
    }),
    status,
  );

/**
 * Handle GET /admin/users
 */
const handleUsersGet: TypedRouteHandler<"GET /admin/users"> = (request) =>
  requireOwnerOr(request, async (session) => {
    const invite = getSearchParam(request, "invite");
    const flash = getFlash();
    return htmlResponse(
      await renderUsersPage(session, {
        currentUserId: session.userId,
        error: flash.error,
        inviteLink: invite,
        success: flash.success,
      }),
    );
  });

/**
 * Handle GET /admin/user/new - show invite user form
 */
const handleUserNewGet = ownerPage((session) => adminUserNewPage(session));

/**
 * Handle POST /admin/users - create invited user
 */
const handleUsersPost = (request: Request): Promise<Response> =>
  withAuth(request, OWNER_FORM, handleUsersPostForm);

const handleUsersPostForm = async (
  _session: AuthSession,
  form: FormParams,
): Promise<Response> => {
  const validation = validateForm<InviteUserFormValues>(form, inviteUserFields);
  if (!validation.valid) {
    return errorRedirect("/admin/user/new", validation.error);
  }

  const { username, admin_level: adminLevel } = validation.values;

  if (!VALID_ADMIN_LEVELS.includes(adminLevel)) {
    return errorRedirect("/admin/user/new", "Invalid role");
  }

  // Check if username is taken
  if (await isUsernameTaken(username)) {
    return errorRedirect("/admin/user/new", "Username is already taken");
  }

  // Generate invite code
  const inviteCode = generateSecureToken();
  const codeHash = await hashInviteCode(inviteCode);
  const expiry = new Date(nowMs() + INVITE_EXPIRY_MS).toISOString();

  await createInvitedUser(username, adminLevel, codeHash, expiry);

  const domain = getEffectiveDomain();
  const inviteLink = `https://${domain}/join/${inviteCode}`;

  await logActivity(`User '${username}' invited as ${adminLevel}`);
  return redirect(
    `/admin/users?invite=${encodeURIComponent(inviteLink)}`,
    "User invited",
    true,
  );
};

type UserErrorPageFn = (error: string, status: number) => Promise<Response>;
type UserActionHandler = (
  user: User,
  session: AuthSession,
  errorPage: UserErrorPageFn,
) => Response | Promise<Response>;

/** Owner auth + fetch user by ID, providing session, errorPage and user to handler */
const withUserAction = (
  request: Request,
  userId: number,
  handler: UserActionHandler,
): Promise<Response> =>
  withAuth(request, OWNER_FORM, async (session) => {
    const errorPage: UserErrorPageFn = (error, status) =>
      usersErrorResponse(session, error, status);
    const user = await getUserById(userId);
    if (!user) return errorPage("User not found", 404);
    return handler(user, session, errorPage);
  });

/**
 * Handle POST /admin/users/:id/activate
 */
const handleUserActivate: UserActionHandler = async (
  user,
  session,
  errorPage,
) => {
  // User must have a password set
  const userHasPassword = await hasPassword(user);
  if (!userHasPassword) {
    return errorPage("User has not set their password yet", 400);
  }

  // User must not already have a data key
  if (user.wrapped_data_key) {
    return errorPage("User is already activated", 400);
  }

  // Get the data key from the current session
  if (!session.wrappedDataKey) {
    return errorPage("Cannot activate: session lacks data key", 500);
  }

  const dataKey = await unwrapKeyWithToken(
    session.wrappedDataKey,
    session.token,
  );

  // Decrypt user's password hash to derive their KEK
  const { decrypt } = await import("#lib/crypto/encryption.ts");
  const decryptedPasswordHash = await decrypt(user.password_hash);

  await activateUser(user.id, dataKey, decryptedPasswordHash);

  const username = await decryptUsername(user);
  await logActivity(`User '${username}' activated`);
  return redirect("/admin/users", "User activated successfully", true);
};

/** Confirmed-delete handlers for users */
const userDelete = createConfirmedHandlers<DisplayUser>({
  identifier: (displayUser) => displayUser.username,
  identifierLabel: "Username",
  load: async (id) => {
    const user = await getUserById(id);
    if (!user) return null;
    return toDisplayUser(user);
  },
  onConfirm: async (displayUser) => {
    await deleteUser(displayUser.id);
    await logActivity(`User '${displayUser.username}' deleted`);
  },
  onNotFound: (_id, session) =>
    usersErrorResponse(session, "User not found", 404),
  path: "/admin/users/:id/delete",
  preValidate: (id, session) =>
    id === session.userId
      ? usersErrorResponse(session, "Cannot delete your own account", 400)
      : null,
  render: (displayUser, session) => adminUserDeletePage(displayUser, session),
  successMessage: "User deleted successfully",
  successRedirect: "/admin/users",
});

/** Create a route handler that runs a user action by ID */
const userActionRoute =
  (
    handler: UserActionHandler,
  ): TypedRouteHandler<"POST /admin/users/:id/activate"> =>
  (request, { id }) =>
    withUserAction(request, id, handler);

/** Handle POST /admin/users/:id/activate */
const handleUserActivatePost = userActionRoute(handleUserActivate);

/** User management routes */
export const usersRoutes = {
  ...userDelete.routes,
  ...defineRoutes({
    "GET /admin/user/new": handleUserNewGet,
    "GET /admin/users": handleUsersGet,
    "POST /admin/users": handleUsersPost,
    "POST /admin/users/:id/activate": handleUserActivatePost,
  }),
};
