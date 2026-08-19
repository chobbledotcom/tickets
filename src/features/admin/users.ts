/* jscpd:ignore-start */

import { fieldById } from "#fp";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";

/**
 * Admin user management routes - owner only
 */

import { unwrapKeyWithToken, wrapKeyWithToken } from "#crypto/keys.ts";
import type { WrappedKey } from "#crypto/sealed.ts";
import { generateSecureToken } from "#crypto/utils.ts";
import { logActivity } from "#db/activity-log.ts";
import { logisticsAgents } from "#db/logistics-agents.ts";
import { settings } from "#db/settings.ts";
import { userAgents } from "#db/user-agents.ts";
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
} from "#db/users.ts";
import { t } from "#i18n";
import { createConfirmedHandlers } from "#routes/admin/confirmation.ts";
import {
  defineEntityPage,
  deleteActionTab,
  type EntityPage,
  type TabDef,
} from "#routes/admin/entity-pages.ts";
import {
  type AuthSession,
  OWNER_FORM,
  ownerPage,
  requireOwnerOr,
} from "#routes/auth.ts";
import { idRouteFor, ownerFormById } from "#routes/entity.ts";
import { errorRedirect, htmlResponse, redirect } from "#routes/response.ts";
import { getSearchParam } from "#routes/url.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import { createAuthedFormRoute } from "#shared/app-forms.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { getFlash } from "#shared/flash-context.ts";
import type { FormParams } from "#shared/form-data.ts";
import { DAY_MS, nowMs } from "#shared/now.ts";
import { selectedIdsFromForm } from "#shared/selected-ids.ts";
import { flashProps } from "#templates/admin/admin-page.tsx";
import {
  adminUserDeletePage,
  adminUserNewPage,
  adminUsersPage,
  agentNamesDisplay,
  type DisplayUser,
  UserAgentsPanel,
  type UsersPageOpts,
  userStatus,
} from "#templates/admin/users.tsx";
import {
  getInviteUserForm,
  type InviteUserFormValues,
} from "#templates/fields/admin.ts";
import type { LogisticsAgent, User } from "#types";

/* jscpd:ignore-end */

/** Invite link expiry: 7 days */
const INVITE_EXPIRY_MS = 7 * DAY_MS;

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
  return fieldById("name")(agents);
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

/** Load and decrypt one user, including assignment names for agent users. */
const loadDisplayUser = async (id: number): Promise<DisplayUser | null> => {
  const user = await getUserById(id);
  return user ? toDisplayUser(user, await loadAgentNameById()) : null;
};

const userOverviewTab: TabDef<DisplayUser> = {
  labelKey: "entity.tab.overview",
  sections: [
    {
      kind: "summary",
      rows: (user) =>
        Promise.resolve([
          { labelKey: "users.col.role", value: user.adminLevel },
          { labelKey: "common.status", value: userStatus(user) },
          ...(user.adminLevel === "agent"
            ? [
                {
                  labelKey: "users.agents.legend",
                  value: agentNamesDisplay(user),
                },
              ]
            : []),
        ]),
    },
  ],
  slug: "",
};

const userActionsTab: TabDef<DisplayUser> = {
  ...deleteActionTab(
    "users.delete_user.submit",
    (user) => `/admin/users/${user.id}/delete`,
  ),
  visible: (user, session) => user.id !== session.userId,
};

/** The owner-only user management and agent-assignment page. */
const userPage: EntityPage<DisplayUser> = defineEntityPage({
  destination: "user",
  load: (id) => loadDisplayUser(id),
  navActive: { section: adminPattern("users") },
  tabs: [
    userOverviewTab,
    {
      intent: "write-form",
      labelKey: "users.agents.edit_link",
      sections: [
        {
          kind: "custom",
          load: async (user) => {
            const [agents, selectedIds] = await Promise.all([
              loadAssignableAgents(),
              userAgents.getIds(user.id),
            ]);
            return UserAgentsPanel({
              action: userPage.path(user.id, "agents"),
              agents,
              selectedIds: new Set(selectedIds),
              user,
            });
          },
        },
      ],
      slug: "agents",
      visible: (user) => user.adminLevel === "agent",
    },
    userActionsTab,
  ],
  titleOf: (user) => user.username,
});

const renderUserTab =
  (tab: string) =>
  (request: Request, { id }: { id: number }): Promise<Response> =>
    userPage.renderTab(request, id, tab);

const handleUserManageGet: TypedRouteHandler<"GET /admin/users/:id"> =
  renderUserTab("");

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

/** Handle GET /admin/users/:id/agents - edit an agent user's logistics agents */
const handleUserAgentsGet: TypedRouteHandler<"GET /admin/users/:id/agents"> =
  renderUserTab("agents");

/** Handle POST /admin/users/:id/agents - save an agent user's logistics agents */
const handleUserAgentsPost: TypedRouteHandler<"POST /admin/users/:id/agents"> =
  ownerFormById(async (id, session, form) => {
    const user = await loadDisplayUser(id);
    if (!user) {
      return usersErrorResponse(session, t("error.user_not_found"), 404);
    }
    if (user.adminLevel !== "agent") {
      return usersErrorResponse(session, t("error.not_agent_user"), 400);
    }
    await saveAgentSelection(user.id, form);
    await logActivity(`Agents updated for user '${user.username}'`);
    return redirect("/admin/users", t("success.agents_updated"), true);
  });

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
export const adminHandlers = defineRoutes({
  "GET /admin/user/new": handleUserNewGet,
  "GET /admin/users": handleUsersGet,
  "GET /admin/users/:id": handleUserManageGet,
  "GET /admin/users/:id/:tab": (request, { id, tab }) =>
    userPage.renderTab(request, id, tab),
  "GET /admin/users/:id/agents": handleUserAgentsGet,
  "GET /admin/users/:id/delete": idRouteFor(userDelete.get),
  "POST /admin/users": handleUsersPost,
  "POST /admin/users/:id/agents": handleUserAgentsPost,
  "POST /admin/users/:id/delete": idRouteFor(userDelete.post),
});
