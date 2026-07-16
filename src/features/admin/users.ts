/* jscpd:ignore-start */

import { mapBy } from "#fp";
import { handlersFor } from "#routes/admin/handlers.ts";
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
import type { TypedRouteHandler } from "#routes/router.ts";
import { getSearchParam } from "#routes/url.ts";
import { createAuthedFormRoute } from "#shared/app-forms.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { unwrapKeyWithToken, wrapKeyWithToken } from "#shared/crypto/keys.ts";
import type { WrappedKey } from "#shared/crypto/sealed.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { logisticsAgents } from "#shared/db/logistics-agents.ts";
import { settings } from "#shared/db/settings.ts";
import { userAgents } from "#shared/db/user-agents.ts";
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
import { nowMs } from "#shared/now.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import { selectedIdsFromForm } from "#shared/selected-ids.ts";
import type { LogisticsAgent, User } from "#shared/types.ts";
import { flashProps } from "#templates/admin/admin-page.tsx";

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
  getInviteUserForm,
  type InviteUserFormValues,
} from "#templates/fields/admin.ts";

/* jscpd:ignore-end */

/** Invite link expiry: 7 days */
const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Valid admin levels */
/** The logistics agents an owner can assign — only when logistics is enabled. */
const loadAssignableAgents = (): Promise<LogisticsAgent[]> =>
  settings.features.logistics ? logisticsAgents.getAll() : Promise.resolve([]);

/** Wrap the shared DATA_KEY under a new invitee's single-use invite code for the
 * keyed roles (owner/manager/agent). Returns an error Response when the inviting
 * owner's session somehow lacks its own key, so editors (which skip this) never
 * pay that check. */
const wrapInviteDataKey = async (
  session: AuthSession,
  inviteCode: string,
): Promise<WrappedKey | Response> => {
  if (!session.wrappedDataKey) {
    return errorRedirect("/admin/user/new", t("error.session_lacks_key"));
  }
  const dataKey = await unwrapKeyWithToken(
    session.wrappedDataKey,
    session.token,
  );
  return wrapKeyWithToken(dataKey, inviteCode);
};

/** Map of assignable logistics-agent id → name, for resolving agent users'
 * assignments to display names. */
const loadAgentNameById = async (): Promise<Map<number, string>> => {
  const agents = await loadAssignableAgents();
  return mapBy("id", (agent: LogisticsAgent) => agent.name)(agents);
};

/** Resolve the chosen `agent_ids` from a form down to the ids that are real
 * logistics agents, dropping anything unknown. */
const parseAssignedAgentIds = (
  form: FormParams,
  agents: LogisticsAgent[],
): number[] => selectedIdsFromForm(form, "agent_ids", agents);

/** Persist a user's logistics-agent links from a submitted form, keeping only
 * ids that are real assignable agents. */
const saveAgentSelection = async (
  userId: number,
  form: FormParams,
): Promise<void> => {
  const agentIds = parseAssignedAgentIds(form, await loadAssignableAgents());
  await userAgents.setIds(userId, agentIds);
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
      ? (await userAgents.getIds(user.id))
          .map((id) => agentNameById.get(id))
          .filter((name): name is string => name !== undefined)
      : undefined;
  // A user is activated once they have set a password (buildUserInsert stores a
  // literal empty string until then). This is the universal activation signal —
  // it holds for keyed roles (owner/manager/agent, who also gain a data key) and
  // for the keyless editor (who never gets one), so status doesn't hinge on the
  // data key the editor deliberately lacks.
  const activated = user.password_hash !== "";
  return {
    activated,
    adminLevel,
    agentNames,
    id: user.id,
    // Only un-activated invites can expire.
    inviteExpired: activated ? false : await isInviteExpired(user),
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

/** The page opts every users screen carries: who is viewing (so their own row
 * can't offer self-delete), plus any flash notices from the last action. */
const userPageOpts = (
  session: AuthSession,
): { currentUserId: number; error?: string; success?: string } => {
  const flash = getFlash();
  return {
    currentUserId: session.userId,
    ...flashProps(flash.error, flash.success),
  };
};

/**
 * Handle GET /admin/users
 */
const handleUsersGet: TypedRouteHandler<"GET /admin/users"> = (request) =>
  requireOwnerOr(request, async (session) =>
    htmlResponse(
      await renderUsersPage(session, {
        ...userPageOpts(session),
        inviteLink: getSearchParam(request, "invite"),
      }),
    ),
  );

/** Build a DisplayUser with its assigned logistics-agent names resolved. */
const toDisplayUserWithAgents = async (user: User): Promise<DisplayUser> =>
  toDisplayUser(user, await loadAgentNameById());

/** Owner-guarded GET handler that loads the target user (or 404s), then renders. */
const ownerUserPage =
  (
    handler: ResponseHandler<
      [user: User, session: AuthSession, errorPage: UserErrorPageFn]
    >,
  ) =>
  (request: Request, { id }: { id: number }): Promise<Response> =>
    requireOwnerOr(request, (session) =>
      withLoadedUser(session, id, (user, errorPage) =>
        handler(user, session, errorPage),
      ),
    );

/** Handle GET /admin/users/:id - per-user management page */
const handleUserManageGet = ownerUserPage(async (user, session) =>
  htmlResponse(
    adminUserManagePage(
      await toDisplayUserWithAgents(user),
      session,
      userPageOpts(session),
    ),
  ),
);

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
    validate: (form) => getInviteUserForm().validate(form),
  },
  onInvalid: ({ error }) => errorRedirect("/admin/user/new", error),
  onValid: async ({ values, form, session }) => {
    const { username, admin_level: adminLevel } = values;

    if (await isUsernameTaken(username)) {
      return errorRedirect("/admin/user/new", t("error.username_taken"));
    }

    const inviteCode = generateSecureToken();
    const codeHash = await hashInviteCode(inviteCode);
    const expiry = new Date(nowMs() + INVITE_EXPIRY_MS).toISOString();

    // Editors hold no DATA_KEY: their invite carries no handoff, so they
    // self-activate at /join without ever gaining the private key that decrypts
    // attendee PII. Every other role gets the shared DATA_KEY wrapped under their
    // single-use invite code, so they self-activate under the password-bound
    // (v2) KEK instead of an admin re-keying them from a stored password hash.
    const inviteWrappedDataKey =
      adminLevel === "editor"
        ? null
        : await wrapInviteDataKey(session, inviteCode);
    if (inviteWrappedDataKey instanceof Response) return inviteWrappedDataKey;

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
type UserErrorPageFn = ResponseHandler<[error: string, status: number]>;

/** Owner-route helper: build the error-page renderer, load the user by id, and
 * 404 when missing — the shared front half of every per-user owner route. */
const withLoadedUser = async (
  session: AuthSession,
  userId: number,
  found: ResponseHandler<[user: User, errorPage: UserErrorPageFn]>,
): Promise<Response> => {
  const errorPage: UserErrorPageFn = (error, status) =>
    usersErrorResponse(session, error, status);
  const user = await getUserById(userId);
  if (!user) return errorPage(t("error.user_not_found"), 404);
  return found(user, errorPage);
};

/** Run `next` only when the user is a delivery agent; otherwise return the
 * error page (agent assignments only apply to delivery agents). */
const withAgentUser = async (
  user: User,
  errorPage: UserErrorPageFn,
  next: () => Promise<Response>,
): Promise<Response> =>
  (await decryptAdminLevel(user)) === "agent"
    ? next()
    : errorPage(t("error.not_agent_user"), 400);

/** Render the edit-agents page for an agent user (or an error response). */
const renderUserAgentsPage = (
  session: AuthSession,
  user: User,
  errorPage: UserErrorPageFn,
  error?: string,
): Promise<Response> =>
  withAgentUser(user, errorPage, async () => {
    const [agents, selectedIds, username] = await Promise.all([
      loadAssignableAgents(),
      userAgents.getIds(user.id),
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
  });

/** Handle GET /admin/users/:id/agents - edit an agent user's logistics agents */
const handleUserAgentsGet = ownerUserPage((user, session, errorPage) =>
  renderUserAgentsPage(session, user, errorPage),
);

/** Handle POST /admin/users/:id/agents - save an agent user's logistics agents */
const handleUserAgentsPost: TypedRouteHandler<
  "POST /admin/users/:id/agents"
> = (request, { id }) =>
  withAuth(request, OWNER_FORM, (session, form) =>
    withLoadedUser(session, id, (user, errorPage) =>
      withAgentUser(user, errorPage, async () => {
        await saveAgentSelection(user.id, form);
        await logActivity(
          `Agents updated for user '${await decryptUsername(user)}'`,
        );
        return redirect("/admin/users", t("success.agents_updated"), true);
      }),
    ),
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
export const adminHandlers = handlersFor("users")({
  getUserNew: handleUserNewGet,
  getUsers: handleUsersGet,
  getUsersById: handleUserManageGet,
  getUsersByIdAgents: handleUserAgentsGet,
  getUsersByIdDelete: (request, { id }) => userDelete.get(request, id),
  postUsers: handleUsersPost,
  postUsersByIdAgents: handleUserAgentsPost,
  postUsersByIdDelete: (request, { id }) => userDelete.post(request, id),
});
