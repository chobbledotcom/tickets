/**
 * Admin user management page template
 */

import { ConfirmForm, CsrfForm, Flash, renderFields } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminLevel, AdminSession } from "#shared/types.ts";
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
  hasDataKey: boolean;
  hasPassword: boolean;
  id: number;
  inviteExpired: boolean;
  username: string;
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
                <td>{user.adminLevel}</td>
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
  error?: string,
): string =>
  String(
    <Layout title="Invite User">
      <AdminNav active="/admin/users" session={session} />

      <CsrfForm action="/admin/users">
        <h1>Invite User</h1>
        <Flash error={error} />
        <Raw html={renderFields(inviteUserFields)} />
        <SubmitButton icon="user-plus">Create Invite</SubmitButton>
      </CsrfForm>
    </Layout>,
  );
