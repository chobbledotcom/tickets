/**
 * Admin user management routes - owner only
 */

import { unwrapKeyWithToken } from "#lib/crypto.ts";
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
import { validateForm } from "#lib/forms.tsx";
import { getAllowedDomain } from "#lib/config.ts";
import { nowMs } from "#lib/now.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import {
  type AuthSession,
  generateSecureToken,
  getSearchParam,
  htmlResponse,
  redirect,
  redirectResponse,
  requireOwnerOr,
  withOwnerAuthForm,
} from "#routes/utils.ts";
import type { User } from "#lib/types.ts";
import {
  adminUserDeletePage,
  adminUserNewPage,
  adminUsersPage,
  type DisplayUser,
  type UsersPageOpts,
} from "#templates/admin/users.tsx";
import { inviteUserFields, type InviteUserFormValues } from "#templates/fields.ts";

/** Invite link expiry: 7 days */
const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Valid admin levels */
const VALID_ADMIN_LEVELS = ["owner", "manager"] as const;

/**
 * Decrypt user data for display
 */
const toDisplayUser = async (
  user: User,
): Promise<DisplayUser> => {
  const userHasPassword = await hasPassword(user);
  return {
    id: user.id,
    username: await decryptUsername(user),
    adminLevel: await decryptAdminLevel(user),
    hasPassword: userHasPassword,
    hasDataKey: user.wrapped_data_key !== null,
    inviteExpired: userHasPassword ? false : await isInviteExpired(user),
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

/**
 * Handle GET /admin/users
 */
const handleUsersGet: TypedRouteHandler<"GET /admin/users"> = (request) =>
  requireOwnerOr(request, async (session) => {
    const invite = getSearchParam(request, "invite");
    const success = getSearchParam(request, "success");
    return htmlResponse(
      await renderUsersPage(session, {
        inviteLink: invite,
        success,
        error: "",
        currentUserId: session.userId,
      }),
    );
  });

/**
 * Handle GET /admin/user/new - show invite user form
 */
const handleUserNewGet = (request: Request): Promise<Response> =>
  requireOwnerOr(request, (session) =>
    htmlResponse(adminUserNewPage(session)));

/**
 * Handle POST /admin/users - create invited user
 */
const handleUsersPost = (request: Request): Promise<Response> =>
  withOwnerAuthForm(request, handleUsersPostForm);

const handleUsersPostForm = async (
  session: AuthSession,
  form: URLSearchParams,
): Promise<Response> => {
    const validation = validateForm<InviteUserFormValues>(form, inviteUserFields);
    if (!validation.valid) {
      return htmlResponse(adminUserNewPage(session, validation.error), 400);
    }

    const { username, admin_level: adminLevel } = validation.values;

    if (!VALID_ADMIN_LEVELS.includes(adminLevel)) {
      return htmlResponse(adminUserNewPage(session, "Invalid role"), 400);
    }

    // Check if username is taken
    if (await isUsernameTaken(username)) {
      return htmlResponse(
        adminUserNewPage(session, "Username is already taken"),
        400,
      );
    }

    // Generate invite code
    const inviteCode = generateSecureToken();
    const codeHash = await hashInviteCode(inviteCode);
    const expiry = new Date(nowMs() + INVITE_EXPIRY_MS).toISOString();

    await createInvitedUser(
      username,
      adminLevel,
      codeHash,
      expiry,
    );

    const domain = getAllowedDomain();
    const inviteLink = `https://${domain}/join/${inviteCode}`;

    await logActivity(`User '${username}' invited as ${adminLevel}`);
    return redirectResponse(`/admin/users?invite=${encodeURIComponent(inviteLink)}`);
};

type UserErrorPageFn = (error: string, status: number) => Promise<Response>;
type UserActionHandler = (user: User, session: AuthSession, errorPage: UserErrorPageFn) => Response | Promise<Response>;

/** Owner auth + fetch user by ID, providing session, errorPage and user to handler */
const withUserAction = (
  request: Request,
  userId: number,
  handler: UserActionHandler,
): Promise<Response> =>
  withOwnerAuthForm(request, async (session) => {
    const errorPage = async (error: string, status: number): Promise<Response> => {
      const html = await renderUsersPage(session, { inviteLink: "", success: "", error, currentUserId: session.userId });
      return htmlResponse(html, status);
    };
    const user = await getUserById(userId);
    if (!user) return errorPage("User not found", 404);
    return handler(user, session, errorPage);
  });

/**
 * Handle POST /admin/users/:id/activate
 */
const handleUserActivate: UserActionHandler = async (user, session, errorPage) => {
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
  const { decrypt } = await import("#lib/crypto.ts");
  const decryptedPasswordHash = await decrypt(user.password_hash);

  await activateUser(user.id, dataKey, decryptedPasswordHash);

  const username = await decryptUsername(user);
  await logActivity(`User '${username}' activated`);
  return redirect("/admin/users", "User activated successfully", true);
};

/**
 * Handle GET /admin/users/:id/delete - show delete confirmation page
 */
const handleUserDeleteGet: TypedRouteHandler<"GET /admin/users/:id/delete"> = (request, { id }) =>
  requireOwnerOr(request, async (session) => {
    if (id === session.userId) {
      return htmlResponse(
        await renderUsersPage(session, {
          inviteLink: "", success: "", error: "Cannot delete your own account", currentUserId: session.userId,
        }),
        400,
      );
    }
    const user = await getUserById(id);
    if (!user) return htmlResponse("Not Found", 404);
    const displayUser = await toDisplayUser(user);
    return htmlResponse(adminUserDeletePage(displayUser, session));
  });

/**
 * Handle POST /admin/users/:id/delete
 */
const handleUserDeletePost: TypedRouteHandler<"POST /admin/users/:id/delete"> = (request, { id }) =>
  withOwnerAuthForm(request, async (session, form) => {
    const user = await getUserById(id);
    if (!user) {
      const html = await renderUsersPage(session, { inviteLink: "", success: "", error: "User not found", currentUserId: session.userId });
      return htmlResponse(html, 404);
    }

    // Cannot delete your own account
    if (user.id === session.userId) {
      const html = await renderUsersPage(session, { inviteLink: "", success: "", error: "Cannot delete your own account", currentUserId: session.userId });
      return htmlResponse(html, 400);
    }

    const username = await decryptUsername(user);
    const confirmName = String(form.get("confirm_identifier") ?? "");
    if (confirmName.trim().toLowerCase() !== username.trim().toLowerCase()) {
      const displayUser = await toDisplayUser(user);
      return htmlResponse(
        adminUserDeletePage(displayUser, session, "Username does not match. Please type the exact username to confirm deletion."),
        400,
      );
    }

    await deleteUser(user.id);

    await logActivity(`User '${username}' deleted`);
    return redirect("/admin/users", "User deleted successfully", true);
  });

/** Create a route handler that runs a user action by ID */
const userActionRoute = (handler: UserActionHandler): TypedRouteHandler<"POST /admin/users/:id/activate"> =>
  (request, { id }) => withUserAction(request, id, handler);

/** Handle POST /admin/users/:id/activate */
const handleUserActivatePost = userActionRoute(handleUserActivate);

/** User management routes */
export const usersRoutes = defineRoutes({
  "GET /admin/users": handleUsersGet,
  "GET /admin/user/new": handleUserNewGet,
  "POST /admin/users": handleUsersPost,
  "POST /admin/users/:id/activate": handleUserActivatePost,
  "GET /admin/users/:id/delete": handleUserDeleteGet,
  "POST /admin/users/:id/delete": handleUserDeletePost,
});
