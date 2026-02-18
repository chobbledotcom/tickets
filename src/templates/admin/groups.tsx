/**
 * Admin group management page templates
 */

import { map, pipe, reduce } from "#fp";
import { buildEmbedSnippets } from "#lib/embed.ts";
import { CsrfForm, renderError, renderFields } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { AdminSession, EventWithCount, Group } from "#lib/types.ts";
import { groupCreateFields, groupFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";
import { EventRow } from "#templates/admin/dashboard.tsx";
import { AdminNav, Breadcrumb } from "#templates/admin/nav.tsx";

const joinStrings = reduce((acc: string, s: string) => acc + s, "");

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
                    <td><a href={`/admin/group/${g.id}`}>{g.name}</a></td>
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
      <CsrfForm action="/admin/group" csrfToken={session.csrfToken}>
        <Raw html={renderFields(groupCreateFields, groupToFieldValues())} />
        <button type="submit">Create Group</button>
      </CsrfForm>
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
      <Breadcrumb href={`/admin/group/${group.id}`} label={group.name} />
      <h1>Edit Group</h1>
      <Raw html={renderError(error)} />
      <CsrfForm action={`/admin/group/${group.id}/edit`} csrfToken={session.csrfToken}>
        <Raw html={renderFields(groupFields, groupToFieldValues(group))} />
        <button type="submit">Save Changes</button>
      </CsrfForm>
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
      <Breadcrumb href={`/admin/group/${group.id}`} label={group.name} />
      <h1>Delete Group</h1>
      <Raw html={renderError(error)} />
      <p>
        Are you sure you want to delete the group <strong>{group.name}</strong> ({group.slug})?
      </p>
      <p>
        Events in this group will not be deleted -- they will be moved out of the group.
      </p>
      <p>Type the group name to confirm:</p>
      <CsrfForm action={`/admin/group/${group.id}/delete`} csrfToken={session.csrfToken}>
        <label>
          Group Name
          <input type="text" name="confirm_identifier" required />
        </label>
        <button type="submit">Delete Group</button>
      </CsrfForm>
    </Layout>,
  );

/**
 * Admin group detail page - shows group info, events in group, and add-events form
 */
export const adminGroupDetailPage = (
  group: Group,
  events: EventWithCount[],
  ungroupedEvents: EventWithCount[],
  session: AdminSession,
  allowedDomain: string,
): string => {
  const eventRows =
    events.length > 0
      ? pipe(map((e: EventWithCount) => EventRow({ e })), joinStrings)(events)
      : '<tr><td colspan="5">No events in this group</td></tr>';

  const ticketUrl = `https://${allowedDomain}/ticket/${group.slug}`;
  const { script: embedScriptCode, iframe: embedIframeCode } = buildEmbedSnippets(ticketUrl);

  return String(
    <Layout title={group.name}>
      <AdminNav session={session} />
      <Breadcrumb href="/admin/groups" label="Groups" />
      <h1>{group.name}</h1>
      {group.terms_and_conditions && (
        <p>Terms and Conditions: {group.terms_and_conditions}</p>
      )}
      <p>
        <a href={`/admin/group/${group.id}/edit`}>Edit Group</a>
        {" "}
        <a href={`/admin/group/${group.id}/delete`}>Delete Group</a>
      </p>

      <article>
        <h2>Group Details</h2>
        <div class="table-scroll">
          <table>
            <tbody>
              <tr>
                <th>Public URL</th>
                <td>
                  <a href={ticketUrl}>{`${allowedDomain}/ticket/${group.slug}`}</a>
                </td>
              </tr>
              <tr>
                <th><label for={`embed-script-${group.id}`}>Embed Script</label></th>
                <td>
                  <input
                    type="text"
                    id={`embed-script-${group.id}`}
                    value={embedScriptCode}
                    readonly
                    data-select-on-click
                  />
                </td>
              </tr>
              <tr>
                <th><label for={`embed-iframe-${group.id}`}>Embed Iframe</label></th>
                <td>
                  <input
                    type="text"
                    id={`embed-iframe-${group.id}`}
                    value={embedIframeCode}
                    readonly
                    data-select-on-click
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </article>

      <h2>Events</h2>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Event Name</th>
              <th>Description</th>
              <th>Status</th>
              <th>Attendees</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            <Raw html={eventRows} />
          </tbody>
        </table>
      </div>

      {ungroupedEvents.length > 0 && (
        <>
          <h2>Add Events to Group</h2>
          <CsrfForm action={`/admin/group/${group.id}/add-events`} csrfToken={session.csrfToken}>
            {ungroupedEvents.map((e) => (
              <label>
                <input type="checkbox" name="event_ids" value={String(e.id)} />
                {` ${e.name}`}
              </label>
            ))}
            <br />
            <button type="submit">Add Selected Events</button>
          </CsrfForm>
        </>
      )}
    </Layout>,
  );
};
