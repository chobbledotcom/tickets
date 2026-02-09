/**
 * Admin user management page template
 */

import { renderError, renderFields } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { AdminLevel, AdminSession } from "#lib/types.ts";
import { inviteUserFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";

/** Displayable user info (decrypted) */
export interface DisplayUser {
  id: number;
  username: string;
  adminLevel: AdminLevel;
  hasPassword: boolean;
  hasDataKey: boolean;
}

/** Status label for a user */
const userStatus = (user: DisplayUser): string => {
  if (user.hasDataKey && user.hasPassword) return "Active";
  if (user.hasPassword && !user.hasDataKey) return "Pending Activation";
  return "Invited";
};

/**
 * Admin user management page
 */
export const adminUsersPage = (
  users: DisplayUser[],
  session: AdminSession,
  inviteLink?: string,
  error?: string,
  success?: string,
): string =>
  String(
    <Layout title="Users">
      <AdminNav session={session} />
      <h1>Users</h1>
      <Raw html={renderError(error)} />
      {success && <div class="success">{success}</div>}

      {inviteLink && (
        <div class="success">
          <p>Invite link (share this with the new user):</p>
          <code>{inviteLink}</code>
          <p><small>This link expires in 7 days.</small></p>
        </div>
      )}

      <h2>Invite New User</h2>
      <form method="POST" action="/admin/users">
        <input type="hidden" name="csrf_token" value={session.csrfToken} />
        <Raw html={renderFields(inviteUserFields)} />
        <button type="submit">Create Invite</button>
      </form>

      <h2>Current Users</h2>
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
                    <form class="inline" method="POST" action={`/admin/users/${user.id}/activate`}>
                      <input type="hidden" name="csrf_token" value={session.csrfToken} />
                      <button type="submit">Activate</button>
                    </form>
                  )}
                </td>
                <td>
                  {user.adminLevel !== "owner" && (
                    <form class="inline" method="POST" action={`/admin/users/${user.id}/delete`}>
                      <input type="hidden" name="csrf_token" value={session.csrfToken} />
                      <button type="submit">Delete</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>
  );
