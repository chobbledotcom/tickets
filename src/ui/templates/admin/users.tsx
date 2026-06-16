/**
 * Admin user management page template
 */

import { t } from "#i18n";
import { ConfirmForm, CsrfForm, Flash, renderFields } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminLevel, AdminSession } from "#shared/types.ts";
import { AdminNav, UsersSubNav } from "#templates/admin/nav.tsx";
import {
  ActionButton,
  GuideLink,
  SubmitButton,
} from "#templates/components/actions.tsx";
import { getInviteUserFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

/** Displayable user info (decrypted) */
export interface DisplayUser {
  adminLevel: AdminLevel;
  hasDataKey: boolean;
  hasPassword: boolean;
  id: number;
  inviteExpired: boolean;
  username: string;
}

/** Status label for a user */
const userStatus = (user: DisplayUser): string => {
  if (user.hasDataKey && user.hasPassword) return t("users.status.active");
  if (user.hasPassword && !user.hasDataKey) return t("users.status.pending");
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
              <th>{t("common.actions")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr>
                <td>{user.username}</td>
                <td>{user.adminLevel}</td>
                <td>{userStatus(user)}</td>
                <td>
                  {user.hasPassword && !user.hasDataKey && (
                    <CsrfForm
                      action={`/admin/users/${user.id}/activate`}
                      class="inline"
                    >
                      <SubmitButton icon="check">
                        {t("users.activate")}
                      </SubmitButton>
                    </CsrfForm>
                  )}
                </td>
                <td>
                  {user.id !== opts.currentUserId && (
                    <a href={`/admin/users/${user.id}/delete`}>
                      {t("common.delete")}
                    </a>
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
  error?: string,
): string =>
  String(
    <Layout title={t("users.invite.title")}>
      <AdminNav active="/admin/users" session={session} />

      <CsrfForm action="/admin/users">
        <h1>{t("users.invite.heading")}</h1>
        <Flash error={error} />
        <Raw html={renderFields(getInviteUserFields())} />
        <SubmitButton icon="user-plus">{t("users.invite.submit")}</SubmitButton>
      </CsrfForm>
    </Layout>,
  );
