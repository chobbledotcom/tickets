/**
 * Admin user management routes - owner only
 */

import { unwrapKeyWithToken } from "#lib/crypto.ts";
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
  isUsernameTaken,
} from "#lib/db/users.ts";
import { validateForm } from "#lib/forms.tsx";
import { getAllowedDomain } from "#lib/config.ts";
import { nowMs } from "#lib/now.ts";
import { defineRoutes } from "#routes/router.ts";
import type { RouteParams } from "#routes/router.ts";
import {
  generateSecureToken,
  getSearchParam,
  htmlResponse,
  redirect,
  redirectWithSuccess,
  requireOwnerOr,
  withOwnerAuthForm,
} from "#routes/utils.ts";
import type { AdminSession, User } from "#lib/types.ts";
import {
  adminUsersPage,
  type DisplayUser,
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
): Promise<DisplayUser> => ({
  id: user.id,
  username: await decryptUsername(user),
  adminLevel: await decryptAdminLevel(user),
  hasPassword: await hasPassword(user),
  hasDataKey: user.wrapped_data_key !== null,
});

/**
 * Render users page with current state
 */
const renderUsersPage = async (
  session: AdminSession,
  inviteLink?: string,
  error?: string,
  success?: string,
): Promise<string> => {
  const users = await getAllUsers();
  const displayUsers = await Promise.all(users.map(toDisplayUser));
  return adminUsersPage(displayUsers, session, inviteLink, error, success);
};

/**
 * Handle GET /admin/users
 */
const handleUsersGet = (request: Request): Promise<Response> =>
  requireOwnerOr(request, async (session) => {
    const invite = getSearchParam(request, "invite");
    const success = getSearchParam(request, "success");
    return htmlResponse(
      await renderUsersPage(
        session,
        invite ?? undefined,
        undefined,
        success ?? undefined,
      ),
    );
  });

/**
 * Handle POST /admin/users - create invited user
 */
const handleUsersPost = (request: Request): Promise<Response> =>
  withOwnerAuthForm(request, async (session, form) => {
    const validation = validateForm<InviteUserFormValues>(form, inviteUserFields);
    if (!validation.valid) {
      return htmlResponse(
        await renderUsersPage(session, undefined, validation.error),
        400,
      );
    }

    const { username, admin_level: adminLevel } = validation.values;

    if (!VALID_ADMIN_LEVELS.includes(adminLevel)) {
      return htmlResponse(
        await renderUsersPage(session, undefined, "Invalid role"),
        400,
      );
    }

    // Check if username is taken
    if (await isUsernameTaken(username)) {
      return htmlResponse(
        await renderUsersPage(
          session,
          undefined,
          "Username is already taken",
        ),
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

    return redirect(`/admin/users?invite=${encodeURIComponent(inviteLink)}`);
  });

/**
 * Handle POST /admin/users/:id/activate
 */
const handleUserActivate = (
  request: Request,
  params: RouteParams,
): Promise<Response> =>
  withOwnerAuthForm(request, async (session) => {
    const userId = Number(params.id);
    const user = await getUserById(userId);

    if (!user) {
      return htmlResponse(
        await renderUsersPage(session, undefined, "User not found"),
        404,
      );
    }

    // User must have a password set
    const userHasPassword = await hasPassword(user);
    if (!userHasPassword) {
      return htmlResponse(
        await renderUsersPage(
          session,
          undefined,
          "User has not set their password yet",
        ),
        400,
      );
    }

    // User must not already have a data key
    if (user.wrapped_data_key) {
      return htmlResponse(
        await renderUsersPage(
          session,
          undefined,
          "User is already activated",
        ),
        400,
      );
    }

    // Get the data key from the current session
    if (!session.wrappedDataKey) {
      return htmlResponse(
        await renderUsersPage(
          session,
          undefined,
          "Cannot activate: session lacks data key",
        ),
        500,
      );
    }

    const dataKey = await unwrapKeyWithToken(
      session.wrappedDataKey,
      session.token,
    );

    // Decrypt user's password hash to derive their KEK
    const { decrypt } = await import("#lib/crypto.ts");
    const decryptedPasswordHash = await decrypt(user.password_hash);

    await activateUser(userId, dataKey, decryptedPasswordHash);

    return redirectWithSuccess("/admin/users", "User activated successfully");
  });

/**
 * Handle POST /admin/users/:id/delete
 */
const handleUserDelete = (
  request: Request,
  params: RouteParams,
): Promise<Response> =>
  withOwnerAuthForm(request, async (session) => {
    const userId = Number(params.id);
    const user = await getUserById(userId);

    if (!user) {
      return htmlResponse(
        await renderUsersPage(session, undefined, "User not found"),
        404,
      );
    }

    // Cannot delete the owner who is performing the action
    const adminLevel = await decryptAdminLevel(user);
    if (adminLevel === "owner" && user.id === session.userId) {
      return htmlResponse(
        await renderUsersPage(
          session,
          undefined,
          "Cannot delete your own account",
        ),
        400,
      );
    }

    await deleteUser(userId);

    return redirectWithSuccess("/admin/users", "User deleted successfully");
  });

/** User management routes */
export const usersRoutes = defineRoutes({
  "GET /admin/users": (request) => handleUsersGet(request),
  "POST /admin/users": (request) => handleUsersPost(request),
  "POST /admin/users/:id/activate": (request, params) =>
    handleUserActivate(request, params),
  "POST /admin/users/:id/delete": (request, params) =>
    handleUserDelete(request, params),
});
