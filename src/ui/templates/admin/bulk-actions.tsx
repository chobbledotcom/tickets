/**
 * Admin bulk-action page templates for groups.
 *
 * Renders the bulk-actions landing page (a list of available operations)
 * and each per-action form page. The duplicate-group form embeds a JSON
 * payload of the source group's listings plus the timezone; the client-side
 * admin bundle uses the shared `#shared/bulk-replace.ts` helpers to recompute
 * the preview as the user types.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import {
  buildDuplicatePreview,
  type DuplicatePreviewRow,
  formatIsoForPreview,
  type PreviewableListing,
} from "#shared/bulk-replace.ts";
import { settings } from "#shared/db/settings.ts";
import { CsrfForm } from "#shared/forms.tsx";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession, Group, ListingWithCount } from "#shared/types.ts";
import { AdminPage, errorAdminPage } from "#templates/admin/admin-page.tsx";
import { ConfirmPage } from "#templates/admin/confirm-page.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { DataTable } from "#templates/components/data-table.tsx";
import { TextField } from "#templates/components/text-field.tsx";
/* jscpd:ignore-end */

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

/** The "← Bulk actions" back-link rendered at the top of the
 *  deactivate/reactivate confirmation pages. */
const bulkActionsBackLink = (group: Group): JSX.Element => (
  <p>
    <a href={`/admin/groups/${group.id}/bulk-actions`}>
      &larr; {t("bulk_actions.page_title")}
    </a>
  </p>
);

/** A `<p>` wrapping a group-name-parameterized confirm prompt string. */
const ConfirmPromptParagraph = (key: string, group: Group): JSX.Element => (
  <p>{t(key, { groupName: group.name })}</p>
);

/** A back-link paragraph to the group's bulk-actions landing or its parent. */
const BackToGroupLink = ({
  group,
  toBulkActions = true,
}: {
  group: Group;
  toBulkActions?: boolean;
}): JSX.Element => (
  <p>
    {toBulkActions ? (
      <a href={`/admin/groups/${group.id}/bulk-actions`}>
        &larr; {t("bulk_actions.page_title")}
      </a>
    ) : (
      <a href={`/admin/groups/${group.id}`}>&larr; {group.name}</a>
    )}
  </p>
);

/** Admin bulk-actions landing page: lists available operations for a group. */
export const adminBulkActionsPage = (
  group: Group,
  listings: ListingWithCount[],
  session: AdminSession,
): string => {
  const hasActive = listings.some((e) => e.active);
  const allDeactivated = listings.length > 0 && !hasActive;
  return String(
    <AdminPage
      active={{ section: "/admin/groups" }}
      session={session}
      title={t("bulk_actions.title_bulk", { name: group.name })}
    >
      <BackToGroupLink group={group} toBulkActions={false} />
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
    </AdminPage>,
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

  return errorAdminPage(
    t("bulk_actions.title_duplicate", { name: group.name }),
    "/admin/groups",
  )(
    session,
    error,
  )(
    <>
      <BackToGroupLink group={group} />
      <div class="prose">
        <h1>{t("bulk_actions.duplicate_form_title")}</h1>
        <p>
          {t("bulk_actions.duplicate_form_description", {
            groupName: group.name,
          })}
        </p>
      </div>

      <CsrfForm
        action={`/admin/groups/${group.id}/bulk-actions/duplicate`}
        data-duplicate-preview
        data-timezone={tz}
        id="duplicate-group-form"
      >
        <TextField
          autofocus
          duplicate
          label={t("bulk_actions.form_new_group_name")}
          name="new_name"
          required
          type="text"
          value={values.newName}
        />
        <TextField
          duplicate
          label={t("bulk_actions.form_find_in_names")}
          name="name_find"
          placeholder={t("bulk_actions.form_find_placeholder")}
          type="text"
          value={values.nameFind || undefined}
        />
        <TextField
          duplicate
          label={t("bulk_actions.form_replace_with")}
          name="name_replace"
          type="text"
          value={values.nameReplace || undefined}
        />
        <p>
          <small>{t("bulk_actions.form_date_shift_help")}</small>
        </p>
        <TextField
          duplicate
          label={t("bulk_actions.form_reference_date")}
          name="date_find"
          type="date"
          value={values.dateFind || undefined}
        />
        <TextField
          duplicate
          label={t("bulk_actions.form_target_date")}
          name="date_replace"
          type="date"
          value={values.dateReplace || undefined}
        />

        <h2>{t("bulk_actions.preview_heading")}</h2>
        {listings.length === 0 ? (
          <p>
            <em>{t("bulk_actions.preview_empty")}</em>
          </p>
        ) : (
          <DataTable
            bodyAttrs={{ "data-duplicate-preview-rows": "" }}
            columns={[
              { header: t("bulk_actions.preview_col_original_name") },
              { header: t("bulk_actions.preview_col_new_name") },
              { header: t("bulk_actions.preview_col_original_date") },
              { header: t("bulk_actions.preview_col_new_date") },
            ]}
            rows={initialRows.map((row) => <PreviewRow row={row} tz={tz} />)}
          />
        )}

        <script id="duplicate-preview-listings" type="application/json">
          <Raw html={listingsJson} />
        </script>

        <SubmitButton icon="plus">
          {t("bulk_actions.submit_duplicate")}
        </SubmitButton>
      </CsrfForm>
    </>,
  );
};

/** Config object passed to {@link bulkConfirmPage} (and built by
 *  {@link activateConfirmPage}). The caller supplies everything except the
 *  `action` URL — the page factory injects that from its `actionSegment` arg. */
type BulkConfirmConfig = {
  action: string;
  buttonText: string;
  children: (count: number, group: Group) => JSX.Element;
  danger?: boolean;
  countPredicate: (listing: ListingWithCount) => boolean;
  titleKey: string;
};

/** Shared ConfirmPage shell for the deactivate/reactivate bulk-action pages:
 *  counts the listings matching `countPredicate`, then renders a ConfirmPage
 *  with the bulk-actions back-link, the standard confirm-form label/name, and
 *  the caller's `children` body (which receives the computed count for its
 *  i18n placeholders). */
const bulkConfirmPage = (
  group: Group,
  listings: ListingWithCount[],
  session: AdminSession,
  error: string | undefined,
  config: BulkConfirmConfig,
): string => {
  const count = listings.filter(config.countPredicate).length;
  return ConfirmPage({
    action: config.action,
    active: { section: "/admin/groups" },
    buttonText: config.buttonText,
    children: config.children(count, group),
    danger: config.danger,
    error,
    label: t("bulk_actions.confirm_form_label"),
    name: group.name,
    prefix: bulkActionsBackLink(group),
    session,
    title: t(config.titleKey, { name: group.name }),
  });
};

/** Common signature for the activate-flipping confirm pages (both the
 *  deactivate and reactivate group pages are built from one config). The
 *  shared `({ group, listings, session, error }) => bulkConfirmPage(...)` wrapper
 *  appeared duplicated across both pages; this curry keeps it in one place. */
const activateConfirmPage =
  (actionSegment: string, config: Omit<BulkConfirmConfig, "action">) =>
  (
    group: Group,
    listings: ListingWithCount[],
    session: AdminSession,
    error?: string,
  ): string =>
    bulkConfirmPage(group, listings, session, error, {
      ...config,
      action: `/admin/groups/${group.id}/bulk-actions/${actionSegment}`,
    });

/** Admin deactivate-group confirmation page */
export const adminDeactivateGroupPage = activateConfirmPage("deactivate", {
  buttonText: t("bulk_actions.deactivate_confirm_button"),
  children: (count, group) => (
    <>
      <p>
        <strong>{t("bulk_actions.deactivate_warning")}</strong>{" "}
        {t("bulk_actions.deactivate_impact", { count })}{" "}
        <strong>{group.name}</strong>.{" "}
        {t("bulk_actions.deactivate_consequences_intro")}
      </p>
      <ul>
        <li>{t("bulk_actions.deactivate_consequence_404")}</li>
        <li>{t("bulk_actions.deactivate_consequence_registrations")}</li>
        <li>{t("bulk_actions.deactivate_consequence_payments")}</li>
      </ul>
      <p>{t("bulk_actions.deactivate_existing_attendees")}</p>
      {ConfirmPromptParagraph("bulk_actions.deactivate_confirm_prompt", group)}
    </>
  ),
  countPredicate: (e) => e.active,
  titleKey: "bulk_actions.title_deactivate",
});

/** Admin reactivate-group confirmation page */
export const adminReactivateGroupPage = activateConfirmPage("reactivate", {
  buttonText: t("bulk_actions.reactivate_confirm_button"),
  children: (count, group) => (
    <>
      <p>
        {t("bulk_actions.reactivate_impact", { count })}{" "}
        <strong>{group.name}</strong>.
      </p>
      <p>{t("bulk_actions.reactivate_benefits")}</p>
      {ConfirmPromptParagraph("bulk_actions.reactivate_confirm_prompt", group)}
    </>
  ),
  countPredicate: (e) => !e.active,
  danger: false,
  titleKey: "bulk_actions.title_reactivate",
});
