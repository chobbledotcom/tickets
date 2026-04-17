/**
 * Admin bulk-action page templates for groups.
 *
 * Renders the bulk-actions landing page (a list of available operations)
 * and each per-action form page. The duplicate-group form embeds a JSON
 * payload of the source group's events plus the timezone; the client-side
 * admin bundle uses the shared `#lib/bulk-replace.ts` helpers to recompute
 * the preview as the user types.
 */

import {
  buildDuplicatePreview,
  type DuplicatePreviewRow,
  formatIsoForPreview,
  type PreviewableEvent,
} from "#lib/bulk-replace.ts";
import { settings } from "#lib/db/settings.ts";
import { ConfirmForm, CsrfForm, Flash } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { AdminSession, EventWithCount, Group } from "#lib/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

/** Form field values for the duplicate-group action */
export interface DuplicateGroupFormValues {
  newName: string;
  nameFind: string;
  nameReplace: string;
  dateFind: string;
  dateReplace: string;
}

/** Embed JSON safely inside a <script type="application/json"> tag */
const safeJson = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, "\\u003c");

/** Admin bulk-actions landing page: lists available operations for a group. */
export const adminBulkActionsPage = (
  group: Group,
  events: EventWithCount[],
  session: AdminSession,
): string => {
  const hasActive = events.some((e) => e.active);
  const allDeactivated = events.length > 0 && !hasActive;
  return String(
    <Layout title={`Bulk Actions: ${group.name}`}>
      <AdminNav session={session} active="/admin/groups" />
      <p>
        <a href={`/admin/groups/${group.id}`}>&larr; {group.name}</a>
      </p>
      <h1>Bulk Actions</h1>
      <p>
        Apply an operation across all {events.length} event
        {events.length === 1 ? "" : "s"} in <strong>{group.name}</strong>.
      </p>

      <ul>
        <li>
          <a href={`/admin/groups/${group.id}/bulk-actions/duplicate`}>
            Duplicate Group
          </a>
          {" — "}Create a new group with a copy of each event, optionally
          replacing a substring in event names and shifting event dates by a
          fixed number of days.
        </li>
        {hasActive && (
          <li>
            <a href={`/admin/groups/${group.id}/bulk-actions/deactivate`}>
              Deactivate Group
            </a>
            {" — "}Deactivate every active event in this group.
          </li>
        )}
        {allDeactivated && (
          <li>
            <a href={`/admin/groups/${group.id}/bulk-actions/reactivate`}>
              Reactivate Group
            </a>
            {" — "}Reactivate every event in this group.
          </li>
        )}
      </ul>
    </Layout>,
  );
};

/** Preview row component: one table row per source event. */
const PreviewRow = ({
  row,
  tz,
}: {
  row: DuplicatePreviewRow;
  tz: string;
}): JSX.Element => (
  <tr data-event-id={String(row.id)}>
    <td data-preview-original-name>{row.originalName}</td>
    <td data-preview-new-name>{row.newName}</td>
    <td data-preview-original-date>
      {formatIsoForPreview(row.originalDate, tz)}
    </td>
    <td data-preview-new-date>{formatIsoForPreview(row.newDate, tz)}</td>
  </tr>
);

/**
 * Admin duplicate-group page: form with live preview.
 * The form submits to POST /admin/groups/:id/bulk-actions/duplicate.
 */
export const adminDuplicateGroupPage = (
  group: Group,
  events: EventWithCount[],
  session: AdminSession,
  error?: string,
  values: DuplicateGroupFormValues = {
    dateFind: "",
    dateReplace: "",
    nameFind: "",
    nameReplace: "",
    newName: `${group.name} (copy)`,
  },
): string => {
  const tz = settings.timezone;
  const initialRows = buildDuplicatePreview(
    events.map(
      (e): PreviewableEvent => ({ date: e.date, id: e.id, name: e.name }),
    ),
    values,
  );
  const eventsJson = safeJson(
    events.map((e) => ({ date: e.date, id: e.id, name: e.name })),
  );

  return String(
    <Layout title={`Duplicate Group: ${group.name}`}>
      <AdminNav session={session} active="/admin/groups" />
      <p>
        <a href={`/admin/groups/${group.id}/bulk-actions`}>
          &larr; Bulk Actions
        </a>
      </p>
      <h1>Duplicate Group</h1>
      <p>
        Creating a new group based on <strong>{group.name}</strong>. Each event
        in the group will be duplicated into the new group with the same
        settings. Use the fields below to apply a name replacement and/or a date
        shift across all duplicates.
      </p>
      <Flash error={error} />

      <CsrfForm
        action={`/admin/groups/${group.id}/bulk-actions/duplicate`}
        id="duplicate-group-form"
        data-duplicate-preview
        data-timezone={tz}
      >
        <label>
          New group name
          <input
            type="text"
            name="new_name"
            value={values.newName}
            required
            autofocus
            data-duplicate-field
          />
        </label>
        <label>
          Find in event names
          <input
            type="text"
            name="name_find"
            value={values.nameFind || undefined}
            placeholder="(leave blank to keep names unchanged)"
            data-duplicate-field="name_find"
          />
        </label>
        <label>
          Replace with
          <input
            type="text"
            name="name_replace"
            value={values.nameReplace || undefined}
            data-duplicate-field="name_replace"
          />
        </label>
        <p>
          <small>
            Enter a reference date that appears in the current events and the
            date you want it to become. All event dates (and closing times) will
            be shifted by the same number of days.
          </small>
        </p>
        <label>
          Reference date
          <input
            type="date"
            name="date_find"
            value={values.dateFind || undefined}
            data-duplicate-field="date_find"
          />
        </label>
        <label>
          Target date
          <input
            type="date"
            name="date_replace"
            value={values.dateReplace || undefined}
            data-duplicate-field="date_replace"
          />
        </label>

        <h2>Preview</h2>
        {events.length === 0 ? (
          <p>
            <em>This group has no events — the new group will be empty.</em>
          </p>
        ) : (
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Original name</th>
                  <th>New name</th>
                  <th>Original date</th>
                  <th>New date</th>
                </tr>
              </thead>
              <tbody data-duplicate-preview-rows>
                {initialRows.map((row) => (
                  <PreviewRow row={row} tz={tz} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <script type="application/json" id="duplicate-preview-events">
          <Raw html={eventsJson} />
        </script>

        <button type="submit">Duplicate Group</button>
      </CsrfForm>
    </Layout>,
  );
};

/** Admin deactivate-group confirmation page */
export const adminDeactivateGroupPage = (
  group: Group,
  events: EventWithCount[],
  session: AdminSession,
  error?: string,
): string => {
  const activeCount = events.filter((e) => e.active).length;
  return String(
    <Layout title={`Deactivate Group: ${group.name}`}>
      <AdminNav session={session} active="/admin/groups" />
      <p>
        <a href={`/admin/groups/${group.id}/bulk-actions`}>
          &larr; Bulk Actions
        </a>
      </p>
      <Flash error={error} />

      <ConfirmForm
        action={`/admin/groups/${group.id}/bulk-actions/deactivate`}
        name={group.name}
        label="Group name"
        buttonText="Deactivate Group"
      >
        <p>
          <strong>Warning:</strong> Deactivating this group will deactivate{" "}
          {activeCount} active event{activeCount === 1 ? "" : "s"} in{" "}
          <strong>{group.name}</strong>. For each deactivated event:
        </p>
        <ul>
          <li>The public ticket page will return a 404 error</li>
          <li>New registrations will be prevented</li>
          <li>Any pending payments will be rejected</li>
        </ul>
        <p>Existing attendees will not be affected.</p>
        <p>
          To deactivate this group, type its name "{group.name}" into the box
          below:
        </p>
      </ConfirmForm>
    </Layout>,
  );
};

/** Admin reactivate-group confirmation page */
export const adminReactivateGroupPage = (
  group: Group,
  events: EventWithCount[],
  session: AdminSession,
  error?: string,
): string => {
  const inactiveCount = events.filter((e) => !e.active).length;
  return String(
    <Layout title={`Reactivate Group: ${group.name}`}>
      <AdminNav session={session} active="/admin/groups" />
      <p>
        <a href={`/admin/groups/${group.id}/bulk-actions`}>
          &larr; Bulk Actions
        </a>
      </p>
      <Flash error={error} />

      <ConfirmForm
        action={`/admin/groups/${group.id}/bulk-actions/reactivate`}
        name={group.name}
        label="Group name"
        buttonText="Reactivate Group"
        danger={false}
      >
        <p>
          Reactivating this group will reactivate {inactiveCount} event
          {inactiveCount === 1 ? "" : "s"} in <strong>{group.name}</strong>.
        </p>
        <p>
          Their public ticket pages will be accessible and new attendees can
          register again.
        </p>
        <p>
          To reactivate this group, type its name "{group.name}" into the box
          below:
        </p>
      </ConfirmForm>
    </Layout>,
  );
};
