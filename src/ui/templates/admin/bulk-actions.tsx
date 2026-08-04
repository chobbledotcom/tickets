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
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { TableColumn } from "#shared/tables/column.ts";
import { defineTable } from "#shared/tables/definition.ts";
import type { AdminSession, Group, ListingWithCount } from "#shared/types.ts";
import { AdminPage, errorAdminPage } from "#templates/admin/admin-page.tsx";
import { ConfirmPage } from "#templates/admin/confirm-page.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { renderTable } from "#templates/components/table.tsx";
import { TextField } from "#templates/components/text-field.tsx";
import { TextFields } from "#templates/components/text-fields.tsx";
import { translatedTableHeader } from "#templates/components/translated-table-column.ts";

/* jscpd:ignore-end */

/** A group bulk-action page: rendered from the group, its listings, the
 * signed-in admin, and an optional error from a failed submit. */
type BulkActionPage = (
  group: Group,
  listings: ListingWithCount[],
  session: AdminSession,
  error?: string,
) => string;

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

/** An i18n line that states a count then ends with the group's name in bold,
 *  like "This affects 12 listings in <b>Summer Camp</b>." */
const CountThenGroup = ({
  messageKey,
  count,
  group,
}: {
  messageKey: string;
  count: number;
  group: Group;
}): JSX.Element => (
  <>
    {t(messageKey, { count })} <strong>{group.name}</strong>.
  </>
);

/** The opening "<count> in <group>" impact paragraph a confirm page leads with.
 *  `lead` and `trail` frame the count sentence (deactivate wraps it with a
 *  warning and the consequences intro; reactivate shows it bare). */
const ImpactParagraph = ({
  count,
  group,
  messageKey,
  lead,
  trail,
}: {
  count: number;
  group: Group;
  messageKey: string;
  lead?: JSX.Element | undefined;
  trail?: JSX.Element | undefined;
}): JSX.Element => (
  <p>
    {lead}
    <CountThenGroup count={count} group={group} messageKey={messageKey} />
    {trail}
  </p>
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
          <CountThenGroup
            count={listings.length}
            group={group}
            messageKey="bulk_actions.landing_description"
          />
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

const previewColumns: readonly TableColumn<DuplicatePreviewRow, string>[] = [
  {
    cell: (row) => row.originalName,
    cellAttrs: () => ({ "data-preview-original-name": true }),
    header: translatedTableHeader("bulk_actions.preview_col_original_name"),
    key: "original_name",
  },
  {
    cell: (row) => row.newName,
    cellAttrs: () => ({ "data-preview-new-name": true }),
    header: translatedTableHeader("bulk_actions.preview_col_new_name"),
    key: "new_name",
  },
  {
    cell: (row, timezone) => formatIsoForPreview(row.originalDate, timezone),
    cellAttrs: () => ({ "data-preview-original-date": true }),
    header: translatedTableHeader("bulk_actions.preview_col_original_date"),
    key: "original_date",
  },
  {
    cell: (row, timezone) => formatIsoForPreview(row.newDate, timezone),
    cellAttrs: () => ({ "data-preview-new-date": true }),
    header: translatedTableHeader("bulk_actions.preview_col_new_date"),
    key: "new_date",
  },
];

const duplicatePreviewTable = defineTable(previewColumns);

/**
 * Admin duplicate-group page: form with live preview.
 * The form submits to POST /admin/groups/:id/bulk-actions/duplicate.
 */
export const adminDuplicateGroupPage: BulkActionPage = (
  group,
  listings,
  session,
  error,
) => {
  const tz = settings.timezone;
  const initialRows = buildDuplicatePreview(
    listings.map(
      (e): PreviewableListing => ({ date: e.date, id: e.id, name: e.name }),
    ),
    { dateFind: "", dateReplace: "", nameFind: "", nameReplace: "" },
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

      <SaveForm
        action={`/admin/groups/${group.id}/bulk-actions/duplicate`}
        data-duplicate-preview
        data-timezone={tz}
        id="duplicate-group-form"
        submitIcon="plus"
        submitLabel={t("bulk_actions.submit_duplicate")}
      >
        <TextField
          autofocus
          duplicate
          label={t("bulk_actions.form_new_group_name")}
          name="new_name"
          required
          type="text"
          value={`${group.name} (copy)`}
        />
        <TextFields
          duplicate
          fields={[
            {
              label: t("bulk_actions.form_find_in_names"),
              name: "name_find",
              placeholder: t("bulk_actions.form_find_placeholder"),
              type: "text",
            },
            {
              label: t("bulk_actions.form_replace_with"),
              name: "name_replace",
              type: "text",
            },
          ]}
        />
        <p>
          <small>{t("bulk_actions.form_date_shift_help")}</small>
        </p>
        <TextFields
          duplicate
          fields={[
            {
              label: t("bulk_actions.form_reference_date"),
              name: "date_find",
              type: "date",
            },
            {
              label: t("bulk_actions.form_target_date"),
              name: "date_replace",
              type: "date",
            },
          ]}
        />

        <h2>{t("bulk_actions.preview_heading")}</h2>
        {listings.length === 0 ? (
          <p>
            <em>{t("bulk_actions.preview_empty")}</em>
          </p>
        ) : (
          renderTable(duplicatePreviewTable, initialRows, {
            bodyAttrs: { "data-duplicate-preview-rows": "" },
            context: tz,
            rowAttrs: (row) => ({ "data-listing-id": String(row.id) }),
          })
        )}

        <script id="duplicate-preview-listings" type="application/json">
          <Raw html={listingsJson} />
        </script>
      </SaveForm>
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

/** The pieces an activate-flipping confirm page supplies as data: the impact
 *  line's message + optional lead/trail, the body between the impact line and
 *  the confirm prompt, and the confirm-prompt message key. */
type ActivateConfig = Omit<BulkConfirmConfig, "action" | "children"> & {
  impactKey: string;
  impactLead?: JSX.Element;
  impactTrail?: JSX.Element;
  body: JSX.Element;
  confirmPromptKey: string;
};

/** Both the deactivate and reactivate group pages are built from one config:
 *  the shared `({ group, listings, session, error }) => bulkConfirmPage(...)`
 *  wrapper AND the shared "impact paragraph → body → confirm prompt" layout
 *  live here once, so each page only declares the words that differ. */
const activateConfirmPage =
  (
    actionSegment: string,
    {
      impactKey,
      impactLead,
      impactTrail,
      body,
      confirmPromptKey,
      ...confirmConfig
    }: ActivateConfig,
  ): BulkActionPage =>
  (group, listings, session, error) =>
    bulkConfirmPage(group, listings, session, error, {
      ...confirmConfig,
      action: `/admin/groups/${group.id}/bulk-actions/${actionSegment}`,
      children: (count, g) => (
        <>
          <ImpactParagraph
            count={count}
            group={g}
            lead={impactLead}
            messageKey={impactKey}
            trail={impactTrail}
          />
          {body}
          {ConfirmPromptParagraph(confirmPromptKey, g)}
        </>
      ),
    });

/** Admin deactivate-group confirmation page */
export const adminDeactivateGroupPage = activateConfirmPage("deactivate", {
  body: (
    <>
      <ul>
        <li>{t("bulk_actions.deactivate_consequence_404")}</li>
        <li>{t("bulk_actions.deactivate_consequence_registrations")}</li>
        <li>{t("bulk_actions.deactivate_consequence_payments")}</li>
      </ul>
      <p>{t("bulk_actions.deactivate_existing_attendees")}</p>
    </>
  ),
  buttonText: t("bulk_actions.deactivate_confirm_button"),
  confirmPromptKey: "bulk_actions.deactivate_confirm_prompt",
  countPredicate: (e) => e.active,
  impactKey: "bulk_actions.deactivate_impact",
  impactLead: (
    <>
      <strong>{t("bulk_actions.deactivate_warning")}</strong>{" "}
    </>
  ),
  impactTrail: <> {t("bulk_actions.deactivate_consequences_intro")}</>,
  titleKey: "bulk_actions.title_deactivate",
});

/** Admin reactivate-group confirmation page */
export const adminReactivateGroupPage = activateConfirmPage("reactivate", {
  body: <p>{t("bulk_actions.reactivate_benefits")}</p>,
  buttonText: t("bulk_actions.reactivate_confirm_button"),
  confirmPromptKey: "bulk_actions.reactivate_confirm_prompt",
  countPredicate: (e) => !e.active,
  danger: false,
  impactKey: "bulk_actions.reactivate_impact",
  titleKey: "bulk_actions.title_reactivate",
});
