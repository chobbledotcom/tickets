/**
 * Admin bulk-action page templates for groups.
 *
 * Renders the bulk-actions landing page (a list of available operations)
 * and each per-action form page. The duplicate-group form embeds a JSON
 * payload of the source group's listings plus the timezone; the client-side
 * admin bundle uses the shared `#shared/bulk-replace.ts` helpers to recompute
 * the preview as the user types.
 */

import {
  buildDuplicatePreview,
  type DuplicatePreviewRow,
  formatIsoForPreview,
  type PreviewableListing,
} from "#shared/bulk-replace.ts";
import { settings } from "#shared/db/settings.ts";
import { ConfirmForm, CsrfForm, Flash } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession, Group, ListingWithCount } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { Layout } from "#templates/layout.tsx";

/** Form field values for the duplicate-group action */
export interface DuplicateGroupFormValues {
  dateFind: string;
  dateReplace: string;
  nameFind: string;
  nameReplace: string;
  newName: string;
}

/** Embed JSON safely inside a <script type="application/json"> tag */
const safeJson = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, "\\u003c");

/** Admin bulk-actions landing page: lists available operations for a group. */
export const adminBulkActionsPage = (
  group: Group,
  listings: ListingWithCount[],
  session: AdminSession,
): string => {
  const hasActive = listings.some((e) => e.active);
  const allDeactivated = listings.length > 0 && !hasActive;
  return String(
    <Layout title={`Bulk Actions: ${group.name}`}>
      <AdminNav active="/admin/groups" session={session} />
      <p>
        <a href={`/admin/groups/${group.id}`}>&larr; {group.name}</a>
      </p>
      <div class="prose">
        <h1>Bulk Actions</h1>
        <p>
          Apply an operation across all {listings.length} listing
          {listings.length === 1 ? "" : "s"} in <strong>{group.name}</strong>.
        </p>
      </div>

      <ul>
        <li>
          <a href={`/admin/groups/${group.id}/bulk-actions/duplicate`}>
            Duplicate Group
          </a>
          {" — "}Create a new group with a copy of each listing, optionally
          replacing a substring in listing names and shifting listing dates by a
          fixed number of days.
        </li>
        {hasActive && (
          <li>
            <a href={`/admin/groups/${group.id}/bulk-actions/deactivate`}>
              Deactivate Group
            </a>
            {" — "}Deactivate every active listing in this group.
          </li>
        )}
        {allDeactivated && (
          <li>
            <a href={`/admin/groups/${group.id}/bulk-actions/reactivate`}>
              Reactivate Group
            </a>
            {" — "}Reactivate every listing in this group.
          </li>
        )}
      </ul>
    </Layout>,
  );
};

/** Preview row component: one table row per source listing. */
const PreviewRow = ({
  row,
  tz,
}: {
  row: DuplicatePreviewRow;
  tz: string;
}): JSX.Element => (
  <tr data-listing-id={String(row.id)}>
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
  listings: ListingWithCount[],
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
    listings.map(
      (e): PreviewableListing => ({ date: e.date, id: e.id, name: e.name }),
    ),
    values,
  );
  const listingsJson = safeJson(
    listings.map((e) => ({ date: e.date, id: e.id, name: e.name })),
  );

  return String(
    <Layout title={`Duplicate Group: ${group.name}`}>
      <AdminNav active="/admin/groups" session={session} />
      <p>
        <a href={`/admin/groups/${group.id}/bulk-actions`}>
          &larr; Bulk Actions
        </a>
      </p>
      <div class="prose">
        <h1>Duplicate Group</h1>
        <p>
          Creating a new group based on <strong>{group.name}</strong>. Each
          listing in the group will be duplicated into the new group with the
          same settings. Use the fields below to apply a name replacement and/or
          a date shift across all duplicates.
        </p>
      </div>
      <Flash error={error} />

      <CsrfForm
        action={`/admin/groups/${group.id}/bulk-actions/duplicate`}
        data-duplicate-preview
        data-timezone={tz}
        id="duplicate-group-form"
      >
        <label>
          New group name
          <input
            autofocus
            data-duplicate-field
            name="new_name"
            required
            type="text"
            value={values.newName}
          />
        </label>
        <label>
          Find in listing names
          <input
            data-duplicate-field="name_find"
            name="name_find"
            placeholder="(leave blank to keep names unchanged)"
            type="text"
            value={values.nameFind || undefined}
          />
        </label>
        <label>
          Replace with
          <input
            data-duplicate-field="name_replace"
            name="name_replace"
            type="text"
            value={values.nameReplace || undefined}
          />
        </label>
        <p>
          <small>
            Enter a reference date that appears in the current listings and the
            date you want it to become. All listing dates (and closing times)
            will be shifted by the same number of days.
          </small>
        </p>
        <label>
          Reference date
          <input
            data-duplicate-field="date_find"
            name="date_find"
            type="date"
            value={values.dateFind || undefined}
          />
        </label>
        <label>
          Target date
          <input
            data-duplicate-field="date_replace"
            name="date_replace"
            type="date"
            value={values.dateReplace || undefined}
          />
        </label>

        <h2>Preview</h2>
        {listings.length === 0 ? (
          <p>
            <em>This group has no listings — the new group will be empty.</em>
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

        <script id="duplicate-preview-listings" type="application/json">
          <Raw html={listingsJson} />
        </script>

        <SubmitButton icon="plus">Duplicate Group</SubmitButton>
      </CsrfForm>
    </Layout>,
  );
};

/** Admin deactivate-group confirmation page */
export const adminDeactivateGroupPage = (
  group: Group,
  listings: ListingWithCount[],
  session: AdminSession,
  error?: string,
): string => {
  const activeCount = listings.filter((e) => e.active).length;
  return String(
    <Layout title={`Deactivate Group: ${group.name}`}>
      <AdminNav active="/admin/groups" session={session} />
      <p>
        <a href={`/admin/groups/${group.id}/bulk-actions`}>
          &larr; Bulk Actions
        </a>
      </p>
      <Flash error={error} />

      <ConfirmForm
        action={`/admin/groups/${group.id}/bulk-actions/deactivate`}
        buttonText="Deactivate Group"
        label="Group name"
        name={group.name}
      >
        <p>
          <strong>Warning:</strong> Deactivating this group will deactivate{" "}
          {activeCount} active listing{activeCount === 1 ? "" : "s"} in{" "}
          <strong>{group.name}</strong>. For each deactivated listing:
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
  listings: ListingWithCount[],
  session: AdminSession,
  error?: string,
): string => {
  const inactiveCount = listings.filter((e) => !e.active).length;
  return String(
    <Layout title={`Reactivate Group: ${group.name}`}>
      <AdminNav active="/admin/groups" session={session} />
      <p>
        <a href={`/admin/groups/${group.id}/bulk-actions`}>
          &larr; Bulk Actions
        </a>
      </p>
      <Flash error={error} />

      <ConfirmForm
        action={`/admin/groups/${group.id}/bulk-actions/reactivate`}
        buttonText="Reactivate Group"
        danger={false}
        label="Group name"
        name={group.name}
      >
        <p>
          Reactivating this group will reactivate {inactiveCount} listing
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
