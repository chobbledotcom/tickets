/**
 * Admin user management page template
 */

import { ConfirmForm, CsrfForm, Flash, renderFields } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { AdminLevel, AdminSession } from "#lib/types.ts";
import { AdminNav, UsersSubNav } from "#templates/admin/nav.tsx";
import { inviteUserFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

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
  if (user.hasDataKey && user.hasPassword) return "Active";
  if (user.hasPassword && !user.hasDataKey) return "Pending Activation";
  if (user.inviteExpired) return "Invite Expired";
  return "Invited";
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
    <Layout title="Users">
      <AdminNav session={session} active="/admin/users" />
      <UsersSubNav />
      <p>
        <a href="/admin/guide#user-classes">User roles and permissions</a>
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

      <p>
        <a href="/admin/user/new">Invite User</a>
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
                <td>{user.adminLevel}</td>
                <td>{userStatus(user)}</td>
                <td>
                  {user.hasPassword && !user.hasDataKey && (
                    <CsrfForm
                      class="inline"
                      action={`/admin/users/${user.id}/activate`}
                    >
                      <button type="submit">Activate</button>
                    </CsrfForm>
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
      <AdminNav session={session} active="/admin/users" />

      <ConfirmForm
        action={`/admin/users/${user.id}/delete`}
        name={user.username}
        label="Username"
        buttonText="Delete User"
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
  error?: string,
): string =>
  String(
    <Layout title="Invite User">
      <AdminNav session={session} active="/admin/users" />

      <CsrfForm action="/admin/users">
        <h1>Invite User</h1>
        <Flash error={error} />
        <Raw html={renderFields(inviteUserFields)} />
        <button type="submit">Create Invite</button>
      </CsrfForm>
    </Layout>,
  );
