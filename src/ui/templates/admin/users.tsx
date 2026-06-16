/**
 * Admin user management page template
 */

import { ConfirmForm, CsrfForm, Flash, renderFields } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type {
  AdminLevel,
  AdminSession,
  LogisticsAgent,
} from "#shared/types.ts";
import { AdminNav, UsersSubNav } from "#templates/admin/nav.tsx";
import {
  ActionButton,
  GuideLink,
  SubmitButton,
} from "#templates/components/actions.tsx";
import { inviteUserFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

/** Displayable user info (decrypted) */
export interface DisplayUser {
  adminLevel: AdminLevel;
  /** For agent users: the names of the logistics agents they're assigned to. */
  agentNames?: string[];
  hasDataKey: boolean;
  hasPassword: boolean;
  id: number;
  inviteExpired: boolean;
  username: string;
}

/** Checkbox list for picking the logistics agents an agent user drives.
 * Submits the chosen ids under the repeated `agent_ids` field. */
const AgentSelector = ({
  agents,
  selected,
}: {
  agents: LogisticsAgent[];
  selected: ReadonlySet<number>;
}): JSX.Element => (
  <fieldset class="checkboxes">
    <legend>Assigned logistics agents</legend>
    <p>
      <small>
        Delivery agents see the run sheet only for the logistics agents ticked
        here. Ignored for owners and managers.
      </small>
    </p>
    {agents.map((agent) => (
      <label>
        <input
          checked={selected.has(agent.id) || undefined}
          name="agent_ids"
          type="checkbox"
          value={String(agent.id)}
        />
        {` ${agent.name}`}
      </label>
    ))}
  </fieldset>
);

/** Status label for a user */
const userStatus = (user: DisplayUser): string => {
  if (user.hasDataKey && user.hasPassword) return "Active";
  if (user.hasPassword && !user.hasDataKey) return "Pending Activation";
  if (user.inviteExpired) return "Invite Expired";
  return "Invited";
};

/**
 * Admin user management page
 */
export interface UsersPageOpts {
  currentUserId: number;
  error?: string;
  inviteLink: string;
  success?: string;
}

export const adminUsersPage = (
  users: DisplayUser[],
  session: AdminSession,
  opts: UsersPageOpts,
): string =>
  String(
    <Layout title="Users">
      <AdminNav active="/admin/users" session={session} />
      <UsersSubNav />
      <p class="actions">
        <GuideLink href="/admin/guide#user-classes">
          User roles and permissions
        </GuideLink>
      </p>
      <Flash error={opts.error} success={opts.success} />

      {opts.inviteLink && (
        <div class="success" role="alert">
          <p>Invite link (share this with the new user):</p>
          <code>{opts.inviteLink}</code>
          <p>
            <small>This link expires in 7 days.</small>
          </p>
        </div>
      )}

      <p class="actions">
        <ActionButton href="/admin/user/new" icon="user-plus">
          Invite User
        </ActionButton>
      </p>

      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Role</th>
              <th>Status</th>
              <th>Actions</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr>
                <td>{user.username}</td>
                <td>
                  {user.adminLevel}
                  {user.adminLevel === "agent" && (
                    <>
                      <br />
                      <small>
                        {user.agentNames && user.agentNames.length > 0
                          ? user.agentNames.join(", ")
                          : "No agents assigned"}
                      </small>
                    </>
                  )}
                </td>
                <td>{userStatus(user)}</td>
                <td>
                  {user.hasPassword && !user.hasDataKey && (
                    <CsrfForm
                      action={`/admin/users/${user.id}/activate`}
                      class="inline"
                    >
                      <SubmitButton icon="check">Activate</SubmitButton>
                    </CsrfForm>
                  )}
                  {user.adminLevel === "agent" && (
                    <a href={`/admin/users/${user.id}/agents`}>Agents</a>
                  )}
                </td>
                <td>
                  {user.id !== opts.currentUserId && (
                    <a href={`/admin/users/${user.id}/delete`}>Delete</a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>,
  );

/**
 * Admin delete user confirmation page
 */
export const adminUserDeletePage = (
  user: DisplayUser,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={`Delete User: ${user.username}`}>
      <AdminNav active="/admin/users" session={session} />

      <ConfirmForm
        action={`/admin/users/${user.id}/delete`}
        buttonText="Delete User"
        label="Username"
        name={user.username}
      >
        <h1>Delete User</h1>
        <Flash error={error} />
        <p>
          <strong>Warning:</strong> This will permanently delete the user{" "}
          <strong>{user.username}</strong> ({user.adminLevel}) and all their
          sessions.
        </p>
        <p>
          To delete this user, type their username "{user.username}" into the
          box below:
        </p>
      </ConfirmForm>
    </Layout>,
  );

/**
 * Admin invite user page
 */
export const adminUserNewPage = (
  session: AdminSession,
  agents: LogisticsAgent[],
  error?: string,
): string =>
  String(
    <Layout title="Invite User">
      <AdminNav active="/admin/users" session={session} />

      <CsrfForm action="/admin/users">
        <h1>Invite User</h1>
        <Flash error={error} />
        <Raw html={renderFields(inviteUserFields)} />
        {agents.length > 0 && (
          <AgentSelector agents={agents} selected={new Set()} />
        )}
        <SubmitButton icon="user-plus">Create Invite</SubmitButton>
      </CsrfForm>
    </Layout>,
  );

/**
 * Admin page for editing which logistics agents an agent user drives.
 */
export const adminUserAgentsPage = (
  user: DisplayUser,
  agents: LogisticsAgent[],
  selectedIds: ReadonlySet<number>,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title={`Agents: ${user.username}`}>
      <AdminNav active="/admin/users" session={session} />

      <h1>Assigned agents for {user.username}</h1>
      <Flash error={error} />
      {agents.length === 0 ? (
        <p>
          <em>
            No logistics agents exist yet. Add some under{" "}
            <a href="/admin/logistics">Logistics</a>.
          </em>
        </p>
      ) : (
        <CsrfForm action={`/admin/users/${user.id}/agents`}>
          <AgentSelector agents={agents} selected={selectedIds} />
          <SubmitButton icon="save">Save Agents</SubmitButton>
        </CsrfForm>
      )}
    </Layout>,
  );
