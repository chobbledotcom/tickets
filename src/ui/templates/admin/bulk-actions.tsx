/**
 * Admin bulk-action page templates for groups.
 *
 * Renders the bulk-actions landing page (a list of available operations)
 * and each per-action form page. The duplicate-group form embeds a JSON
 * payload of the source group's listings plus the timezone; the client-side
 * admin bundle uses the shared `#shared/bulk-replace.ts` helpers to recompute
 * the preview as the user types.
 */

import { t } from "#i18n";
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
    <Layout title={t("bulk_actions.title_bulk", { name: group.name })}>
      <AdminNav active="/admin/groups" session={session} />
      <p>
        <a href={`/admin/groups/${group.id}`}>&larr; {group.name}</a>
      </p>
      <div class="prose">
        <h1>{t("bulk_actions.page_title")}</h1>
        <p>
          {t("bulk_actions.landing_description", { count: listings.length })}{" "}
          <strong>{group.name}</strong>.
        </p>
      </div>

      <ul>
        <li>
          <a href={`/admin/groups/${group.id}/bulk-actions/duplicate`}>
            {t("bulk_actions.action_duplicate_group")}
          </a>
          {" — "}
          {t("bulk_actions.action_duplicate_group_desc")}
        </li>
        {hasActive && (
          <li>
            <a href={`/admin/groups/${group.id}/bulk-actions/deactivate`}>
              {t("bulk_actions.action_deactivate_group")}
            </a>
            {" — "}
            {t("bulk_actions.action_deactivate_group_desc")}
          </li>
        )}
        {allDeactivated && (
          <li>
            <a href={`/admin/groups/${group.id}/bulk-actions/reactivate`}>
              {t("bulk_actions.action_reactivate_group")}
            </a>
            {" — "}
            {t("bulk_actions.action_reactivate_group_desc")}
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
    <Layout title={t("bulk_actions.title_duplicate", { name: group.name })}>
      <AdminNav active="/admin/groups" session={session} />
      <p>
        <a href={`/admin/groups/${group.id}/bulk-actions`}>
          &larr; {t("bulk_actions.page_title")}
        </a>
      </p>
      <div class="prose">
        <h1>{t("bulk_actions.duplicate_form_title")}</h1>
        <p>
          {t("bulk_actions.duplicate_form_description", {
            groupName: group.name,
          })}
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
          {t("bulk_actions.form_new_group_name")}
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
          {t("bulk_actions.form_find_in_names")}
          <input
            data-duplicate-field="name_find"
            name="name_find"
            placeholder={t("bulk_actions.form_find_placeholder")}
            type="text"
            value={values.nameFind || undefined}
          />
        </label>
        <label>
          {t("bulk_actions.form_replace_with")}
          <input
            data-duplicate-field="name_replace"
            name="name_replace"
            type="text"
            value={values.nameReplace || undefined}
          />
        </label>
        <p>
          <small>{t("bulk_actions.form_date_shift_help")}</small>
        </p>
        <label>
          {t("bulk_actions.form_reference_date")}
          <input
            data-duplicate-field="date_find"
            name="date_find"
            type="date"
            value={values.dateFind || undefined}
          />
        </label>
        <label>
          {t("bulk_actions.form_target_date")}
          <input
            data-duplicate-field="date_replace"
            name="date_replace"
            type="date"
            value={values.dateReplace || undefined}
          />
        </label>

        <h2>{t("bulk_actions.preview_heading")}</h2>
        {listings.length === 0 ? (
          <p>
            <em>{t("bulk_actions.preview_empty")}</em>
          </p>
        ) : (
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("bulk_actions.preview_col_original_name")}</th>
                  <th>{t("bulk_actions.preview_col_new_name")}</th>
                  <th>{t("bulk_actions.preview_col_original_date")}</th>
                  <th>{t("bulk_actions.preview_col_new_date")}</th>
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

        <SubmitButton icon="plus">
          {t("bulk_actions.submit_duplicate")}
        </SubmitButton>
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
    <Layout title={t("bulk_actions.title_deactivate", { name: group.name })}>
      <AdminNav active="/admin/groups" session={session} />
      <p>
        <a href={`/admin/groups/${group.id}/bulk-actions`}>
          &larr; {t("bulk_actions.page_title")}
        </a>
      </p>
      <Flash error={error} />

      <ConfirmForm
        action={`/admin/groups/${group.id}/bulk-actions/deactivate`}
        buttonText={t("bulk_actions.deactivate_confirm_button")}
        label={t("bulk_actions.confirm_form_label")}
        name={group.name}
      >
        <p>
          <strong>{t("bulk_actions.deactivate_warning")}</strong>{" "}
          {t("bulk_actions.deactivate_impact", { count: activeCount })}{" "}
          <strong>{group.name}</strong>.{" "}
          {t("bulk_actions.deactivate_consequences_intro")}
        </p>
        <ul>
          <li>{t("bulk_actions.deactivate_consequence_404")}</li>
          <li>{t("bulk_actions.deactivate_consequence_registrations")}</li>
          <li>{t("bulk_actions.deactivate_consequence_payments")}</li>
        </ul>
        <p>{t("bulk_actions.deactivate_existing_attendees")}</p>
        <p>
          {t("bulk_actions.deactivate_confirm_prompt", {
            groupName: group.name,
          })}
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
    <Layout title={t("bulk_actions.title_reactivate", { name: group.name })}>
      <AdminNav active="/admin/groups" session={session} />
      <p>
        <a href={`/admin/groups/${group.id}/bulk-actions`}>
          &larr; {t("bulk_actions.page_title")}
        </a>
      </p>
      <Flash error={error} />

      <ConfirmForm
        action={`/admin/groups/${group.id}/bulk-actions/reactivate`}
        buttonText={t("bulk_actions.reactivate_confirm_button")}
        danger={false}
        label={t("bulk_actions.confirm_form_label")}
        name={group.name}
      >
        <p>
          {t("bulk_actions.reactivate_impact", { count: inactiveCount })}{" "}
          <strong>{group.name}</strong>.
        </p>
        <p>{t("bulk_actions.reactivate_benefits")}</p>
        <p>
          {t("bulk_actions.reactivate_confirm_prompt", {
            groupName: group.name,
          })}
        </p>
      </ConfirmForm>
    </Layout>,
  );
};
