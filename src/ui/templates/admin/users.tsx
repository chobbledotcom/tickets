/**
 * Admin user management page template
 */

import { t } from "#i18n";
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
  DeleteSection,
  GuideLink,
  SubmitButton,
} from "#templates/components/actions.tsx";
import { getInviteUserFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

/** Displayable user info (decrypted) */
export interface DisplayUser {
  adminLevel: AdminLevel;
  /** For agent users: the names of the logistics agents they're assigned to. */
  agentNames?: string[];
  hasDataKey: boolean;
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
    <legend>{t("users.agents.legend")}</legend>
    <p>
      <small>{t("users.agents.hint")}</small>
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
  // A user with a data key has joined and self-activated; otherwise they are an
  // outstanding invite, which is either still open or expired.
  if (user.hasDataKey) return t("users.status.active");
  if (user.inviteExpired) return t("users.status.expired");
  return t("users.status.invited");
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
    <Layout title={t("terms.users")}>
      <AdminNav active="/admin/users" session={session} />
      <UsersSubNav />
      <p class="actions">
        <GuideLink href="/admin/guide#user-classes">
          {t("users.roles_link")}
        </GuideLink>
      </p>
      <Flash error={opts.error} success={opts.success} />

      {opts.inviteLink && (
        <div class="success" role="alert">
          <p>{t("users.invite_link_label")}</p>
          <code>{opts.inviteLink}</code>
          <p>
            <small>{t("users.invite_expires")}</small>
          </p>
        </div>
      )}

      <p class="actions">
        <ActionButton href="/admin/user/new" icon="user-plus">
          {t("users.invite_user")}
        </ActionButton>
      </p>

      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t("common.username")}</th>
              <th>{t("users.col.role")}</th>
              <th>{t("common.status")}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr>
                <td>
                  <a href={`/admin/users/${user.id}`}>{user.username}</a>
                </td>
                <td>
                  {user.adminLevel}
                  {user.adminLevel === "agent" && (
                    <>
                      <br />
                      <small>
                        {user.agentNames && user.agentNames.length > 0
                          ? user.agentNames.join(", ")
                          : t("users.agents.none_assigned")}
                      </small>
                    </>
                  )}
                </td>
                <td>{userStatus(user)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>,
  );

/**
 * Per-user management page — the destination for the username link in the
 * users table. Consolidates the activate, edit-agents, and delete actions that
 * used to sit inline in the table's "Actions" columns.
 */
export const adminUserManagePage = (
  user: DisplayUser,
  session: AdminSession,
  opts: { currentUserId: number; error?: string; success?: string },
): string =>
  String(
    <Layout title={`${t("terms.users")}: ${user.username}`}>
      <AdminNav active="/admin/users" session={session} />
      <UsersSubNav />
      <h1>{user.username}</h1>
      <Flash error={opts.error} success={opts.success} />

      <div class="table-scroll">
        <table class="listing-details-table">
          <tbody>
            <tr>
              <th>{t("users.col.role")}</th>
              <td>{user.adminLevel}</td>
            </tr>
            <tr>
              <th>{t("common.status")}</th>
              <td>{userStatus(user)}</td>
            </tr>
            {user.adminLevel === "agent" && (
              <tr>
                <th>{t("users.agents.legend")}</th>
                <td>
                  {user.agentNames && user.agentNames.length > 0
                    ? user.agentNames.join(", ")
                    : t("users.agents.none_assigned")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p class="actions">
        {user.adminLevel === "agent" && (
          <ActionButton
            href={`/admin/users/${user.id}/agents`}
            variant="secondary"
          >
            {t("users.agents.edit_link")}
          </ActionButton>
        )}
      </p>

      {user.id !== opts.currentUserId && (
        <DeleteSection
          heading={t("common.delete")}
          href={`/admin/users/${user.id}/delete`}
        >
          {t("users.delete_user.submit")}
        </DeleteSection>
      )}
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
    <Layout title={`${t("users.delete_user.heading")}: ${user.username}`}>
      <AdminNav active="/admin/users" session={session} />

      <ConfirmForm
        action={`/admin/users/${user.id}/delete`}
        buttonText={t("users.delete_user.submit")}
        label={t("common.username")}
        name={user.username}
      >
        <h1>{t("users.delete_user.heading")}</h1>
        <Flash error={error} />
        <p>
          {t("users.delete_user.warning", {
            level: user.adminLevel,
            username: user.username,
          })}
        </p>
        <p>
          {t("users.delete_user.confirm_prompt", { username: user.username })}
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
    <Layout title={t("users.invite.title")}>
      <AdminNav active="/admin/users" session={session} />

      <CsrfForm action="/admin/users">
        <h1>{t("users.invite.heading")}</h1>
        <Flash error={error} />
        <Raw html={renderFields(getInviteUserFields())} />
        {agents.length > 0 && (
          <AgentSelector agents={agents} selected={new Set()} />
        )}
        <SubmitButton icon="user-plus">{t("users.invite.submit")}</SubmitButton>
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
    <Layout title={`${t("users.agents.title")}: ${user.username}`}>
      <AdminNav active="/admin/users" session={session} />

      <h1>{t("users.agents.heading", { username: user.username })}</h1>
      <Flash error={error} />
      {agents.length === 0 ? (
        <p>
          <em>
            {t("users.agents.none_exist")}{" "}
            <a href="/admin/logistics">{t("nav.logistics")}</a>.
          </em>
        </p>
      ) : (
        <CsrfForm action={`/admin/users/${user.id}/agents`}>
          <AgentSelector agents={agents} selected={selectedIds} />
          <SubmitButton icon="save">{t("users.agents.save")}</SubmitButton>
        </CsrfForm>
      )}
    </Layout>,
  );
