/**
 * Admin user management page template
 */

import { CsrfForm, renderError, renderFields } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { AdminLevel, AdminSession } from "#lib/types.ts";
import { AdminNav, Breadcrumb, UsersSubNav } from "#templates/admin/nav.tsx";
import { inviteUserFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";
import { t } from "#i18n";

/** Displayable user info (decrypted) */
export interface DisplayUser {
  id: number;
  username: string;
  adminLevel: AdminLevel;
  hasPassword: boolean;
  hasDataKey: boolean;
  inviteExpired: boolean;
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
  inviteLink: string;
  success?: string;
  error?: string;
  currentUserId: number;
}

export const adminUsersPage = (
  users: DisplayUser[],
  session: AdminSession,
  opts: UsersPageOpts,
): string =>
  String(
    <Layout title={t("users.title")}>
      <AdminNav session={session} active="/admin/users" />
      <UsersSubNav />
      <h1>{t("users.heading")}</h1>
      <p>
        <a href="/admin/sessions">{t("users.sessions_link")}</a>
      </p>
      <p>
        <a href="/admin/guide#user-classes">{t("users.roles_link")}</a>
      </p>
      <Raw html={renderError(opts.error)} />
      {opts.success && <div class="success">{opts.success}</div>}

      {opts.inviteLink && (
        <div class="success">
          <p>{t("users.invite_link_label")}</p>
          <code>{opts.inviteLink}</code>
          <p>
            <small>{t("users.invite_expires")}</small>
          </p>
        </div>
      )}

      <p>
        <a href="/admin/user/new">{t("users.invite_user")}</a>
      </p>

      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t("users.col.username")}</th>
              <th>{t("users.col.role")}</th>
              <th>{t("users.col.status")}</th>
              <th>{t("users.col.actions")}</th>
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
                      class="inline"
                      action={`/admin/users/${user.id}/activate`}
                    >
                      <button type="submit">{t("users.activate")}</button>
                    </CsrfForm>
                  )}
                </td>
                <td>
                  {user.id !== opts.currentUserId && (
                    <a href={`/admin/users/${user.id}/delete`}>{t("users.delete")}</a>
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
      <AdminNav session={session} active="/admin/users" />
      <Breadcrumb href="/admin/users" label={t("users.heading")} />
      <h1>{t("users.delete_user.heading")}</h1>
      <Raw html={renderError(error)} />

      <article>
        <aside>
          <p>
            {t("users.delete_user.warning", { username: user.username, level: user.adminLevel })}
          </p>
        </aside>
      </article>

      <p>
        {t("users.delete_user.confirm_prompt", { username: user.username })}
      </p>

      <CsrfForm action={`/admin/users/${user.id}/delete`}>
        <label for="confirm_identifier">{t("users.delete_user.confirm_label")}</label>
        <input
          type="text"
          id="confirm_identifier"
          name="confirm_identifier"
          placeholder={user.username}
          autocomplete="off"
          required
        />
        <button type="submit" class="danger">
          {t("users.delete_user.submit")}
        </button>
      </CsrfForm>
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
      <AdminNav session={session} active="/admin/users" />
      <Breadcrumb href="/admin/users" label={t("users.heading")} />
      <h1>{t("users.invite.heading")}</h1>
      <Raw html={renderError(error)} />
      <CsrfForm action="/admin/users">
        <Raw html={renderFields(inviteUserFields)} />
        <button type="submit">{t("users.invite.submit")}</button>
      </CsrfForm>
    </Layout>,
  );
