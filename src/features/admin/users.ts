/**
 * Admin user management routes - owner only
 */

import { createConfirmedHandlers } from "#routes/admin/confirmation.ts";
import {
  type AuthSession,
  generateSecureToken,
  OWNER_FORM,
  ownerPage,
  requireOwnerOr,
  withAuth,
} from "#routes/auth.ts";
import { errorRedirect, htmlResponse, redirect } from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { getSearchParam } from "#routes/url.ts";
import { createAuthedFormRoute } from "#shared/app-forms.ts";
/* jscpd:ignore-start */
import { getEffectiveDomain } from "#shared/config.ts";
import { unwrapKeyWithToken } from "#shared/crypto/keys.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { getAllLogisticsAgents } from "#shared/db/logistics-agents.ts";
import { settings } from "#shared/db/settings.ts";
import { getUserAgentIds, setUserAgentIds } from "#shared/db/user-agents.ts";
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
} from "#shared/db/users.ts";
import { getFlash } from "#shared/flash-context.ts";
import type { FormParams } from "#shared/form-data.ts";
import { validateForm } from "#shared/forms.tsx";
import { nowMs } from "#shared/now.ts";
import type { LogisticsAgent, User } from "#shared/types.ts";

import {
  adminUserAgentsPage,
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

/* jscpd:ignore-end */

/** Invite link expiry: 7 days */
const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Valid admin levels */
const VALID_ADMIN_LEVELS = ["owner", "manager", "agent"] as const;

/** The logistics agents an owner can assign — only when logistics is enabled. */
const loadAssignableAgents = (): Promise<LogisticsAgent[]> =>
  settings.hasLogistics ? getAllLogisticsAgents() : Promise.resolve([]);

/** Resolve the chosen `agent_ids` from a form down to the ids that are real
 * logistics agents, dropping anything unknown. */
const parseAssignedAgentIds = (
  form: FormParams,
  agents: LogisticsAgent[],
): number[] => {
  const valid = new Set(agents.map((a) => a.id));
  return form.getNumberArray("agent_ids").filter((id) => valid.has(id));
};

/**
 * Decrypt user data for display. When an agent-name lookup is supplied, agent
 * users also get the names of their assigned logistics agents.
 */
const toDisplayUser = async (
  user: User,
  agentNameById?: Map<number, string>,
): Promise<DisplayUser> => {
  const userHasPassword = await hasPassword(user);
  const adminLevel = await decryptAdminLevel(user);
  const agentNames =
    adminLevel === "agent" && agentNameById
      ? (await getUserAgentIds(user.id))
          .map((id) => agentNameById.get(id))
          .filter((name): name is string => name !== undefined)
      : undefined;
  return {
    adminLevel,
    agentNames,
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
  const [users, agents] = await Promise.all([
    getAllUsers(),
    loadAssignableAgents(),
  ]);
  const agentNameById = new Map(agents.map((a) => [a.id, a.name]));
  const displayUsers = await Promise.all(
    users.map((user) => toDisplayUser(user, agentNameById)),
  );
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
const handleUserNewGet = ownerPage(async (session) =>
  adminUserNewPage(session, await loadAssignableAgents()),
);

/** Handle POST /admin/users - create invited user */
const handleUsersPost = createAuthedFormRoute<InviteUserFormValues>({
  auth: OWNER_FORM,
  form: {
    validate: (form) =>
      validateForm<InviteUserFormValues>(form, inviteUserFields),
  },
  onInvalid: ({ error }) => errorRedirect("/admin/user/new", error),
  onValid: async ({ values, form }) => {
    const { username, admin_level: adminLevel } = values;

    if (!VALID_ADMIN_LEVELS.includes(adminLevel)) {
      return errorRedirect("/admin/user/new", "Invalid role");
    }
    if (await isUsernameTaken(username)) {
      return errorRedirect("/admin/user/new", "Username is already taken");
    }

    const inviteCode = generateSecureToken();
    const codeHash = await hashInviteCode(inviteCode);
    const expiry = new Date(nowMs() + INVITE_EXPIRY_MS).toISOString();

    const user = await createInvitedUser(
      username,
      adminLevel,
      codeHash,
      expiry,
    );

    // Agent users carry the logistics agents they drive; ignored for staff.
    if (adminLevel === "agent") {
      const agentIds = parseAssignedAgentIds(
        form,
        await loadAssignableAgents(),
      );
      await setUserAgentIds(user.id, agentIds);
    }

    const inviteLink = `https://${getEffectiveDomain()}/join/${inviteCode}`;
    await logActivity(`User '${username}' invited as ${adminLevel}`);
    return redirect(
      `/admin/users?invite=${encodeURIComponent(inviteLink)}`,
      "User invited",
      true,
    );
  },
});

/** Render the edit-agents page for an agent user (or an error response). */
const renderUserAgentsPage = async (
  session: AuthSession,
  user: User,
  errorPage: UserErrorPageFn,
  error?: string,
): Promise<Response> => {
  const adminLevel = await decryptAdminLevel(user);
  if (adminLevel !== "agent") {
    return errorPage("Only delivery agents have assigned agents", 400);
  }
  const [agents, selectedIds, username] = await Promise.all([
    loadAssignableAgents(),
    getUserAgentIds(user.id),
    decryptUsername(user),
  ]);
  const displayUser = await toDisplayUser(user);
  return htmlResponse(
    adminUserAgentsPage(
      { ...displayUser, username },
      agents,
      new Set(selectedIds),
      session,
      error,
    ),
  );
};

/** Handle GET /admin/users/:id/agents - edit an agent user's logistics agents */
const handleUserAgentsGet: TypedRouteHandler<"GET /admin/users/:id/agents"> = (
  request,
  { id },
) =>
  requireOwnerOr(request, async (session) => {
    const errorPage: UserErrorPageFn = (error, status) =>
      usersErrorResponse(session, error, status);
    const user = await getUserById(id);
    if (!user) return errorPage("User not found", 404);
    return renderUserAgentsPage(session, user, errorPage);
  });

/** Handle POST /admin/users/:id/agents - save an agent user's logistics agents */
const handleUserAgentsPost: TypedRouteHandler<
  "POST /admin/users/:id/agents"
> = (request, { id }) =>
  withAuth(request, OWNER_FORM, async (session, form) => {
    const errorPage: UserErrorPageFn = (error, status) =>
      usersErrorResponse(session, error, status);
    const user = await getUserById(id);
    if (!user) return errorPage("User not found", 404);
    if ((await decryptAdminLevel(user)) !== "agent") {
      return errorPage("Only delivery agents have assigned agents", 400);
    }
    const agentIds = parseAssignedAgentIds(form, await loadAssignableAgents());
    await setUserAgentIds(user.id, agentIds);
    const username = await decryptUsername(user);
    await logActivity(`Agents updated for user '${username}'`);
    return redirect("/admin/users", "Agents updated", true);
  });

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
  const { decrypt } = await import("#shared/crypto/encryption.ts");
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
    "GET /admin/users/:id/agents": handleUserAgentsGet,
    "POST /admin/users": handleUsersPost,
    "POST /admin/users/:id/activate": handleUserActivatePost,
    "POST /admin/users/:id/agents": handleUserAgentsPost,
  }),
};
