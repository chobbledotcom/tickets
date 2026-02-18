/**
 * Admin user management page template
 */

import { renderError, renderFields } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { AdminLevel, AdminSession } from "#lib/types.ts";
import { inviteUserFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";
import { AdminNav, Breadcrumb } from "#templates/admin/nav.tsx";

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
export interface UsersPageOpts {
  inviteLink: string;
  success: string;
  error: string;
}

export const adminUsersPage = (
  users: DisplayUser[],
  session: AdminSession,
  opts: UsersPageOpts,
): string =>
  String(
    <Layout title="Users">
      <AdminNav session={session} />
      <h1>Users</h1>
      <p>
        <a href="/admin/guide#user-classes">User roles and permissions</a>
      </p>
      <Raw html={renderError(opts.error)} />
      {opts.success && <div class="success">{opts.success}</div>}

      {opts.inviteLink && (
        <div class="success">
          <p>Invite link (share this with the new user):</p>
          <code>{opts.inviteLink}</code>
          <p><small>This link expires in 7 days.</small></p>
        </div>
      )}

      <p><a href="/admin/user/new">Invite User</a></p>

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

/**
 * Admin invite user page
 */
export const adminUserNewPage = (
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title="Invite User">
      <AdminNav session={session} />
      <Breadcrumb href="/admin/users" label="Users" />
      <h1>Invite User</h1>
      <Raw html={renderError(error)} />
      <form method="POST" action="/admin/users">
        <input type="hidden" name="csrf_token" value={session.csrfToken} />
        <Raw html={renderFields(inviteUserFields)} />
        <button type="submit">Create Invite</button>
      </form>
    </Layout>,
  );
