/**
 * Admin user management routes - owner only
 */

import { t } from "#i18n";
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
import { unwrapKeyWithToken, wrapKeyWithToken } from "#shared/crypto/keys.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { getAllLogisticsAgents } from "#shared/db/logistics-agents.ts";
import { settings } from "#shared/db/settings.ts";
import { getUserAgentIds, setUserAgentIds } from "#shared/db/user-agents.ts";
import {
  createInvitedUser,
  decryptAdminLevel,
  decryptUsername,
  deleteUser,
  getAllUsers,
  getUserById,
  hashInviteCode,
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
  adminUserManagePage,
  adminUserNewPage,
  adminUsersPage,
  type DisplayUser,
  type UsersPageOpts,
} from "#templates/admin/users.tsx";
import {
  getInviteUserFields,
  type InviteUserFormValues,
} from "#templates/fields.ts";

/* jscpd:ignore-end */

/** Invite link expiry: 7 days */
const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Valid admin levels */
const VALID_ADMIN_LEVELS = ["owner", "manager", "agent"] as const;

/** The logistics agents an owner can assign — only when logistics is enabled. */
const loadAssignableAgents = (): Promise<LogisticsAgent[]> =>
  settings.hasLogistics ? getAllLogisticsAgents() : Promise.resolve([]);

/** Map of assignable logistics-agent id → name, for resolving agent users'
 * assignments to display names. */
const loadAgentNameById = async (): Promise<Map<number, string>> => {
  const agents = await loadAssignableAgents();
  return new Map(agents.map((a) => [a.id, a.name]));
};

/** Resolve the chosen `agent_ids` from a form down to the ids that are real
 * logistics agents, dropping anything unknown. */
const parseAssignedAgentIds = (
  form: FormParams,
  agents: LogisticsAgent[],
): number[] => {
  const valid = new Set(agents.map((a) => a.id));
  return form.getNumberArray("agent_ids").filter((id) => valid.has(id));
};

/** Persist a user's logistics-agent links from a submitted form, keeping only
 * ids that are real assignable agents. */
const saveAgentSelection = async (
  userId: number,
  form: FormParams,
): Promise<void> => {
  const agentIds = parseAssignedAgentIds(form, await loadAssignableAgents());
  await setUserAgentIds(userId, agentIds);
};

/**
 * Decrypt user data for display. When an agent-name lookup is supplied, agent
 * users also get the names of their assigned logistics agents.
 */
const toDisplayUser = async (
  user: User,
  agentNameById?: Map<number, string>,
): Promise<DisplayUser> => {
  const adminLevel = await decryptAdminLevel(user);
  const agentNames =
    adminLevel === "agent" && agentNameById
      ? (await getUserAgentIds(user.id))
          .map((id) => agentNameById.get(id))
          .filter((name): name is string => name !== undefined)
      : undefined;
  const hasDataKey = user.wrapped_data_key !== null;
  return {
    adminLevel,
    agentNames,
    hasDataKey,
    id: user.id,
    // An activated user has a data key; only un-activated invites can expire.
    inviteExpired: hasDataKey ? false : await isInviteExpired(user),
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
  const [users, agentNameById] = await Promise.all([
    getAllUsers(),
    loadAgentNameById(),
  ]);
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

/** Build a DisplayUser with its assigned logistics-agent names resolved. */
const toDisplayUserWithAgents = async (user: User): Promise<DisplayUser> =>
  toDisplayUser(user, await loadAgentNameById());

/** Owner-guarded GET handler that loads the target user (or 404s), then renders. */
const ownerUserPage =
  (
    handler: (
      user: User,
      session: AuthSession,
      errorPage: UserErrorPageFn,
    ) => Response | Promise<Response>,
  ) =>
  (request: Request, { id }: { id: number }): Promise<Response> =>
    requireOwnerOr(request, (session) =>
      withLoadedUser(session, id, (user, errorPage) =>
        handler(user, session, errorPage),
      ),
    );

/** Handle GET /admin/users/:id - per-user management page */
const handleUserManageGet = ownerUserPage(async (user, session) => {
  const displayUser = await toDisplayUserWithAgents(user);
  const flash = getFlash();
  return htmlResponse(
    adminUserManagePage(displayUser, session, {
      currentUserId: session.userId,
      error: flash.error,
      success: flash.success,
    }),
  );
});

/**
 * Handle GET /admin/user/new - show invite user form
 */
const handleUserNewGet = ownerPage(async (session) =>
  adminUserNewPage(session, await loadAssignableAgents(), getFlash().error),
);

/** Handle POST /admin/users - create invited user */
const handleUsersPost = createAuthedFormRoute<InviteUserFormValues>({
  auth: OWNER_FORM,
  form: {
    validate: (form) =>
      validateForm<InviteUserFormValues>(form, getInviteUserFields()),
  },
  onInvalid: ({ error }) => errorRedirect("/admin/user/new", error),
  onValid: async ({ values, form, session }) => {
    const { username, admin_level: adminLevel } = values;

    if (!VALID_ADMIN_LEVELS.includes(adminLevel)) {
      return errorRedirect("/admin/user/new", t("error.invalid_role"));
    }
    if (await isUsernameTaken(username)) {
      return errorRedirect("/admin/user/new", t("error.username_taken"));
    }
    if (!session.wrappedDataKey) {
      return errorRedirect("/admin/user/new", t("error.session_lacks_key"));
    }

    const inviteCode = generateSecureToken();
    const codeHash = await hashInviteCode(inviteCode);
    const expiry = new Date(nowMs() + INVITE_EXPIRY_MS).toISOString();

    // Hand the shared DATA_KEY to the invitee wrapped under their single-use
    // invite code, so they self-activate at /join under the password-bound (v2)
    // KEK instead of an admin re-keying them from a stored password hash.
    const dataKey = await unwrapKeyWithToken(
      session.wrappedDataKey,
      session.token,
    );
    const inviteWrappedDataKey = await wrapKeyWithToken(dataKey, inviteCode);

    const user = await createInvitedUser(
      username,
      adminLevel,
      codeHash,
      expiry,
      inviteWrappedDataKey,
    );

    // Agent users carry the logistics agents they drive; ignored for staff.
    if (adminLevel === "agent") {
      await saveAgentSelection(user.id, form);
    }

    const inviteLink = `https://${getEffectiveDomain()}/join/${inviteCode}`;
    await logActivity(`User '${username}' invited as ${adminLevel}`);
    return redirect(
      `/admin/users?invite=${encodeURIComponent(inviteLink)}`,
      t("success.user_invited"),
      true,
    );
  },
});

/** Re-renders the users list with a flash error at the given status. */
type UserErrorPageFn = (error: string, status: number) => Promise<Response>;

/** Owner-route helper: build the error-page renderer, load the user by id, and
 * 404 when missing — the shared front half of every per-user owner route. */
const withLoadedUser = async (
  session: AuthSession,
  userId: number,
  found: (
    user: User,
    errorPage: UserErrorPageFn,
  ) => Response | Promise<Response>,
): Promise<Response> => {
  const errorPage: UserErrorPageFn = (error, status) =>
    usersErrorResponse(session, error, status);
  const user = await getUserById(userId);
  if (!user) return errorPage(t("error.user_not_found"), 404);
  return found(user, errorPage);
};

/** Null when the user is a delivery agent; otherwise the error response to
 * return (agent assignments only apply to delivery agents). */
const ensureAgentUser = async (
  user: User,
  errorPage: UserErrorPageFn,
): Promise<Response | null> =>
  (await decryptAdminLevel(user)) === "agent"
    ? null
    : errorPage(t("error.not_agent_user"), 400);

/** Render the edit-agents page for an agent user (or an error response). */
const renderUserAgentsPage = async (
  session: AuthSession,
  user: User,
  errorPage: UserErrorPageFn,
  error?: string,
): Promise<Response> => {
  const notAgent = await ensureAgentUser(user, errorPage);
  if (notAgent) return notAgent;
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
const handleUserAgentsGet = ownerUserPage((user, session, errorPage) =>
  renderUserAgentsPage(session, user, errorPage),
);

/** Handle POST /admin/users/:id/agents - save an agent user's logistics agents */
const handleUserAgentsPost: TypedRouteHandler<
  "POST /admin/users/:id/agents"
> = (request, { id }) =>
  withAuth(request, OWNER_FORM, (session, form) =>
    withLoadedUser(session, id, async (user, errorPage) => {
      const notAgent = await ensureAgentUser(user, errorPage);
      if (notAgent) return notAgent;
      await saveAgentSelection(user.id, form);
      await logActivity(
        `Agents updated for user '${await decryptUsername(user)}'`,
      );
      return redirect("/admin/users", t("success.agents_updated"), true);
    }),
  );

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
    usersErrorResponse(session, t("error.user_not_found"), 404),
  path: "/admin/users/:id/delete",
  preValidate: (id, session) =>
    id === session.userId
      ? usersErrorResponse(session, t("error.cannot_delete_self"), 400)
      : null,
  render: (displayUser, session, error) =>
    adminUserDeletePage(displayUser, session, error),
  successMessage: t("success.user_deleted"),
  successRedirect: "/admin/users",
});

/** User management routes */
export const usersRoutes = {
  ...userDelete.routes,
  ...defineRoutes({
    "GET /admin/user/new": handleUserNewGet,
    "GET /admin/users": handleUsersGet,
    "GET /admin/users/:id": handleUserManageGet,
    "GET /admin/users/:id/agents": handleUserAgentsGet,
    "POST /admin/users": handleUsersPost,
    "POST /admin/users/:id/agents": handleUserAgentsPost,
  }),
};
