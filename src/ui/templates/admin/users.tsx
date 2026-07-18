/**
 * Admin user management page template
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import type {
  AdminLevel,
  AdminSession,
  LogisticsAgent,
} from "#shared/types.ts";
import { errorAdminPage, flashOptsPage } from "#templates/admin/admin-page.tsx";
import { entityDeletePage } from "#templates/admin/confirm-page.tsx";
import { GuideFooter } from "#templates/components/actions.tsx";
import {
  CheckboxFieldset,
  CheckboxLabel,
} from "#templates/components/aggregate-sections.tsx";
import { DataTable, textCol } from "#templates/components/data-table.tsx";
import { NewResourceForm } from "#templates/components/new-resource-form.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { getInviteUserForm } from "#templates/fields/admin.ts";
/* jscpd:ignore-end */

/** Displayable user info (decrypted) */
export interface DisplayUser {
  /** True once the user has set a password via /join. For keyed roles this also
   * means they hold a data key; the keyless editor activates without one. */
  activated: boolean;
  adminLevel: AdminLevel;
  /** For agent users: the names of the logistics agents they're assigned to. */
  agentNames?: string[] | undefined;
  id: number;
  inviteExpired: boolean;
  username: string;
}

/** Checkbox list for picking the logistics agents an agent user drives.
 * Submits the chosen ids under the repeated `agent_ids` field. */
type AgentSelectorProps = {
  agents: LogisticsAgent[];
  selected: ReadonlySet<number>;
};

const AgentSelector = ({
  agents,
  selected,
}: AgentSelectorProps): JSX.Element => (
  <CheckboxFieldset
    className="checkboxes"
    hint={t("users.agents.hint")}
    legend={t("users.agents.legend")}
  >
    {agents.map((agent) => (
      <CheckboxLabel
        checked={selected.has(agent.id) || undefined}
        label={` ${agent.name}`}
        name="agent_ids"
        value={String(agent.id)}
      />
    ))}
  </CheckboxFieldset>
);

/** Comma-joined assigned agent names, or the "none assigned" fallback. */
export const agentNamesDisplay = (user: DisplayUser): string =>
  user.agentNames && user.agentNames.length > 0
    ? user.agentNames.join(", ")
    : t("users.agents.none_assigned");

/** Status label for a user */
export const userStatus = (user: DisplayUser): string => {
  // An activated user has joined and set a password; otherwise they are an
  // outstanding invite, which is either still open or expired.
  if (user.activated) return t("users.status.active");
  if (user.inviteExpired) return t("users.status.expired");
  return t("users.status.invited");
};

/**
 * Admin user management page
 */
export interface UsersPageOpts {
  currentUserId: number;
  error?: string | undefined;
  inviteLink: string;
  success?: string | undefined;
}

export const adminUsersPage = (
  users: DisplayUser[],
  session: AdminSession,
  opts: UsersPageOpts,
): string =>
  flashOptsPage(t("terms.users"), "/admin/users")(session, opts)(
    <>
      {opts.inviteLink && (
        <div class="success" role="alert">
          <p>{t("users.invite_link_label")}</p>
          <code>{opts.inviteLink}</code>
          <p>
            <small>{t("users.invite_expires")}</small>
          </p>
        </div>
      )}

      <DataTable
        columns={[
          textCol("common.username"),
          textCol("users.col.role"),
          textCol("common.status"),
        ]}
        rows={users.map((user) => [
          <a href={`/admin/users/${user.id}`}>{user.username}</a>,
          <>
            {user.adminLevel}
            {user.adminLevel === "agent" && (
              <>
                <br />
                <small>{agentNamesDisplay(user)}</small>
              </>
            )}
          </>,
          userStatus(user),
        ])}
      />

      <GuideFooter href="/admin/guide#user-classes">
        {t("users.roles_link")}
      </GuideFooter>
    </>,
  );

/**
 * Admin delete user confirmation page
 */
export const adminUserDeletePage = entityDeletePage((user: DisplayUser) => ({
  action: `/admin/users/${user.id}/delete`,
  active: "/admin/users",
  buttonText: t("users.delete_user.submit"),
  children: (
    <>
      <h1>{t("users.delete_user.heading")}</h1>
      <p>
        {t("users.delete_user.warning", {
          level: user.adminLevel,
          username: user.username,
        })}
      </p>
      <p>
        {t("users.delete_user.confirm_prompt", { username: user.username })}
      </p>
    </>
  ),
  label: t("common.username"),
  name: user.username,
  title: `${t("users.delete_user.heading")}: ${user.username}`,
}));

/**
 * Admin invite user page
 */
export const adminUserNewPage = (
  session: AdminSession,
  agents: LogisticsAgent[],
  error?: string,
): string =>
  errorAdminPage(t("users.invite.title"), "/admin/user/new")(session, error)(
    <NewResourceForm
      action="/admin/users"
      fieldsHtml={getInviteUserForm().render()}
      submitIcon="user-plus"
      submitLabel={t("users.invite.submit")}
      title={t("users.invite.heading")}
    >
      {agents.length > 0 && (
        <AgentSelector agents={agents} selected={new Set()} />
      )}
    </NewResourceForm>,
  );

export interface UserAgentsPanelProps {
  action: string;
  agents: LogisticsAgent[];
  selectedIds: ReadonlySet<number>;
  user: DisplayUser;
}

/** Form panel for choosing which logistics agents an agent user drives. */
export const UserAgentsPanel = ({
  action,
  agents,
  selectedIds,
  user,
}: UserAgentsPanelProps): JSX.Element => (
  <>
    <h2>{t("users.agents.heading", { username: user.username })}</h2>
    {agents.length === 0 ? (
      <p>
        <em>
          {t("users.agents.none_exist")}{" "}
          <a href="/admin/logistics">{t("nav.logistics")}</a>.
        </em>
      </p>
    ) : (
      <SaveForm action={action} submitLabel={t("users.agents.save")}>
        <AgentSelector agents={agents} selected={selectedIds} />
      </SaveForm>
    )}
  </>
);
