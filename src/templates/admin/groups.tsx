/**
 * Admin group management page templates
 */

import { renderError, renderFields } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { AdminSession, Group } from "#lib/types.ts";
import { groupFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";
import { AdminNav, Breadcrumb } from "#templates/admin/nav.tsx";

/**
 * Admin groups list page
 */
export const adminGroupsPage = (
  groups: Group[],
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title="Groups">
      <AdminNav session={session} />
      <h1>Groups</h1>
      <Raw html={renderError(error)} />
      <p><a href="/admin/group/new">Add Group</a></p>
      {groups.length === 0
        ? <p>No groups configured.</p>
        : (
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Slug</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr>
                    <td>{g.name}</td>
                    <td>{g.slug}</td>
                    <td>
                      <a href={`/admin/group/${g.id}/edit`}>Edit</a>
                      {" "}
                      <a href={`/admin/group/${g.id}/delete`}>Delete</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </Layout>,
  );

/**
 * Group create/edit form values
 */
export const groupToFieldValues = (
  group?: Group,
): Record<string, string | number | null> => {
  const name = group?.name ?? "";
  const slug = group?.slug ?? "";
  const terms = group?.terms_and_conditions ?? "";
  return { name, slug, terms_and_conditions: terms };
};

/**
 * Admin group create page
 */
export const adminGroupNewPage = (
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title="Add Group">
      <AdminNav session={session} />
      <Breadcrumb href="/admin/groups" label="Groups" />
      <h1>Add Group</h1>
      <Raw html={renderError(error)} />
      <form method="POST" action="/admin/group">
        <input type="hidden" name="csrf_token" value={session.csrfToken} />
        <Raw html={renderFields(groupFields, groupToFieldValues())} />
        <button type="submit">Create Group</button>
      </form>
    </Layout>,
  );

/**
 * Admin group edit page
 */
export const adminGroupEditPage = (
  group: Group,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title="Edit Group">
      <AdminNav session={session} />
      <Breadcrumb href="/admin/groups" label="Groups" />
      <h1>Edit Group</h1>
      <Raw html={renderError(error)} />
      <form method="POST" action={`/admin/group/${group.id}/edit`}>
        <input type="hidden" name="csrf_token" value={session.csrfToken} />
        <Raw html={renderFields(groupFields, groupToFieldValues(group))} />
        <button type="submit">Save Changes</button>
      </form>
    </Layout>,
  );

/**
 * Admin group delete confirmation page
 */
export const adminGroupDeletePage = (
  group: Group,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout title="Delete Group">
      <AdminNav session={session} />
      <Breadcrumb href="/admin/groups" label="Groups" />
      <h1>Delete Group</h1>
      <Raw html={renderError(error)} />
      <p>
        Are you sure you want to delete the group <strong>{group.name}</strong> ({group.slug})?
      </p>
      <p>
        Events in this group will not be deleted -- they will be moved out of the group.
      </p>
      <p>Type the group name to confirm:</p>
      <form method="POST" action={`/admin/group/${group.id}/delete`}>
        <input type="hidden" name="csrf_token" value={session.csrfToken} />
        <label>
          Group Name
          <input type="text" name="confirm_identifier" required />
        </label>
        <button type="submit">Delete Group</button>
      </form>
    </Layout>,
  );
