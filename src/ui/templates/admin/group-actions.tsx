/**
 * Form-page templates for the group-wide actions: Duplicate Group, Deactivate
 * Group, and Reactivate Group. The duplicate-group form embeds a JSON payload
 * of the source group's listings plus the timezone; the client-side admin
 * bundle uses the shared `#shared/bulk-replace.ts` helpers to recompute the
 * preview as the user types.
 */

import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { adminPath } from "#shared/admin-surface.ts";
import {
  buildDuplicatePreview,
  type DuplicatePreviewRow,
  formatIsoForPreview,
  type PreviewableListing,
} from "#shared/bulk-replace.ts";
import { savedFormValueOrNull } from "#shared/forms/saved-data.ts";
import type { TableColumn } from "#shared/tables/column.ts";
import { defineTable } from "#shared/tables/definition.ts";
import { errorAdminPage } from "#templates/admin/admin-page.tsx";
import { ConfirmPage } from "#templates/admin/confirm-page.tsx";
import { DeactivationEffects } from "#templates/components/deactivation-effects.tsx";
import { JsonScript } from "#templates/components/json-script.tsx";
import { MessageParagraph } from "#templates/components/message-para.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { renderTable } from "#templates/components/table.tsx";
import { TextField } from "#templates/components/text-field.tsx";
import { TextFields } from "#templates/components/text-fields.tsx";
import { translatedTableColumn } from "#templates/components/translated-table-column.ts";
import type { AdminSession, Group, ListingWithCount } from "#types";

/** A group action page: rendered from the group, its listings, the signed-in
 * admin, and an optional error from a failed submit. */
type GroupActionPage = (
  group: Group,
  listings: ListingWithCount[],
  session: AdminSession,
  error?: string,
) => string;

/** The "← <group>" back-link to the group page, which is where the Actions
 *  tab links these pages from. */
const BackToGroupLink = ({ group }: { group: Group }): JSX.Element => (
  <p>
    <a href={adminPath("group", { id: group.id })}>&larr; {group.name}</a>
  </p>
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

/** One duplicate-preview column. The client-side preview recomputation reads
 *  each cell through its data attribute, which spells the column key with
 *  hyphens instead of underscores. */
const previewTableColumn = <TRow, const TKey extends string>(
  key: TKey,
  headerKey: string,
  cell: TableColumn<TRow, string, TKey>["cell"],
): TableColumn<TRow, string, TKey> =>
  translatedTableColumn(key, headerKey, cell, {
    cellAttrs: () => ({ [`data-preview-${key.replaceAll("_", "-")}`]: true }),
  });

const previewColumns: readonly TableColumn<DuplicatePreviewRow, string>[] = [
  previewTableColumn(
    "original_name",
    "group_actions.preview_col_original_name",
    (row) => row.originalName,
  ),
  previewTableColumn(
    "new_name",
    "group_actions.preview_col_new_name",
    (row) => row.newName,
  ),
  previewTableColumn(
    "original_date",
    "group_actions.preview_col_original_date",
    (row, timezone) => formatIsoForPreview(row.originalDate, timezone),
  ),
  previewTableColumn(
    "new_date",
    "group_actions.preview_col_new_date",
    (row, timezone) => formatIsoForPreview(row.newDate, timezone),
  ),
];

const duplicatePreviewTable = defineTable(previewColumns);

/**
 * Admin duplicate-group page: form with live preview.
 * The form submits to POST /admin/groups/:id/duplicate.
 */
export const adminDuplicateGroupPage: GroupActionPage = (
  group,
  listings,
  session,
  error,
) => {
  const tz = settings.timezone;
  // A failed duplicate restores the submitted replacements into the form.
  // The preview must open on those same values, not on empty ones.
  const restored = {
    dateFind: savedFormValueOrNull("date_find") ?? "",
    dateReplace: savedFormValueOrNull("date_replace") ?? "",
    nameFind: savedFormValueOrNull("name_find") ?? "",
    nameReplace: savedFormValueOrNull("name_replace") ?? "",
  };
  const initialRows = buildDuplicatePreview(
    listings.map(
      (e): PreviewableListing => ({ date: e.date, id: e.id, name: e.name }),
    ),
    restored,
  );
  const listingsData = listings.map((e) => ({
    date: e.date,
    id: e.id,
    name: e.name,
  }));

  return errorAdminPage(
    t("group_actions.title_duplicate", { name: group.name }),
    "/admin/groups",
  )(
    session,
    error,
  )(
    <>
      <BackToGroupLink group={group} />
      <div class="prose">
        <h1>{t("group_actions.duplicate_form_title")}</h1>
        <p>
          {t("group_actions.duplicate_form_description", {
            groupName: group.name,
          })}
        </p>
      </div>

      <SaveForm
        action={adminPath("groupDuplicate", { id: group.id })}
        data-duplicate-preview
        data-timezone={tz}
        id="duplicate-group-form"
        submitIcon="plus"
        submitLabel={t("group_actions.submit_duplicate")}
      >
        <TextField
          autofocus
          duplicate
          label={t("group_actions.form_new_group_name")}
          name="new_name"
          required
          type="text"
          value={savedFormValueOrNull("new_name") ?? `${group.name} (copy)`}
        />
        <TextFields
          duplicate
          fields={[
            {
              label: t("group_actions.form_find_in_names"),
              name: "name_find",
              placeholder: t("group_actions.form_find_placeholder"),
              type: "text",
              value: restored.nameFind,
            },
            {
              label: t("group_actions.form_replace_with"),
              name: "name_replace",
              type: "text",
              value: restored.nameReplace,
            },
          ]}
        />
        <p>
          <small>{t("group_actions.form_date_shift_help")}</small>
        </p>
        <TextFields
          duplicate
          fields={[
            {
              label: t("group_actions.form_reference_date"),
              name: "date_find",
              type: "date",
              value: restored.dateFind,
            },
            {
              label: t("group_actions.form_target_date"),
              name: "date_replace",
              type: "date",
              value: restored.dateReplace,
            },
          ]}
        />

        <h2>{t("group_actions.preview_heading")}</h2>
        {listings.length === 0 ? (
          <p>
            <em>{t("group_actions.preview_empty")}</em>
          </p>
        ) : (
          renderTable(duplicatePreviewTable, initialRows, {
            bodyAttrs: { "data-duplicate-preview-rows": "" },
            context: tz,
            rowAttrs: (row) => ({ "data-listing-id": String(row.id) }),
          })
        )}

        <JsonScript id="duplicate-preview-listings" value={listingsData} />
      </SaveForm>
    </>,
  );
};

/** Config object passed to {@link groupConfirmPage} (and built by
 *  {@link activateConfirmPage}). The caller supplies everything except the
 *  `action` URL — the page factory injects that from its destination id. */
type GroupActionConfirmConfig = {
  action: string;
  buttonText: string;
  children: (count: number, group: Group) => JSX.Element;
  danger?: boolean;
  countPredicate: (listing: ListingWithCount) => boolean;
  titleKey: string;
};

/** Shared ConfirmPage shell for the deactivate/reactivate group action pages:
 *  counts the listings matching `countPredicate`, then renders a ConfirmPage
 *  with the back-link to the group, the standard confirm-form label/name, and
 *  the caller's `children` body (which receives the computed count for its
 *  i18n placeholders). */
// Calls ConfirmPage directly: the page is built from a group AND its listings,
// not the single (entity, session, error?) shape entityDeletePage builds.
const groupConfirmPage = (
  group: Group,
  listings: ListingWithCount[],
  session: AdminSession,
  error: string | undefined,
  config: GroupActionConfirmConfig,
): string => {
  const count = listings.filter(config.countPredicate).length;
  return ConfirmPage({
    action: config.action,
    active: { section: "/admin/groups" },
    buttonText: config.buttonText,
    children: config.children(count, group),
    danger: config.danger,
    error,
    label: t("group_actions.confirm_form_label"),
    name: group.name,
    prefix: <BackToGroupLink group={group} />,
    session,
    title: t(config.titleKey, { name: group.name }),
  });
};

/** The pieces an activate-flipping confirm page supplies as data: the impact
 *  line's message + optional lead/trail, the body between the impact line and
 *  the confirm prompt, and the confirm-prompt message key. */
type ActivateConfig = Omit<GroupActionConfirmConfig, "action" | "children"> & {
  impactKey: string;
  impactLead?: JSX.Element;
  impactTrail?: JSX.Element;
  body: JSX.Element;
  confirmPromptKey: string;
};

/** Both the deactivate and reactivate group pages are built from one config:
 *  the shared `({ group, listings, session, error }) => groupConfirmPage(...)`
 *  wrapper AND the shared "impact paragraph → body → confirm prompt" layout
 *  live here once, so each page only declares the words that differ. */
const activateConfirmPage =
  (
    destination: "groupDeactivate" | "groupReactivate",
    {
      impactKey,
      impactLead,
      impactTrail,
      body,
      confirmPromptKey,
      ...confirmConfig
    }: ActivateConfig,
  ): GroupActionPage =>
  (group, listings, session, error) =>
    groupConfirmPage(group, listings, session, error, {
      ...confirmConfig,
      action: adminPath(destination, { id: group.id }),
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
          <MessageParagraph
            messageKey={confirmPromptKey}
            values={{ groupName: g.name }}
          />
        </>
      ),
    });

/** Admin deactivate-group confirmation page */
export const adminDeactivateGroupPage = activateConfirmPage("groupDeactivate", {
  body: (
    <DeactivationEffects
      effect404={t("group_actions.deactivate_consequence_404")}
      effectPayments={t("group_actions.deactivate_consequence_payments")}
      effectRegistrations={t(
        "group_actions.deactivate_consequence_registrations",
      )}
      existingAttendeesNote={t("group_actions.deactivate_existing_attendees")}
    />
  ),
  buttonText: t("group_actions.deactivate_confirm_button"),
  confirmPromptKey: "group_actions.deactivate_confirm_prompt",
  countPredicate: (e) => e.active,
  impactKey: "group_actions.deactivate_impact",
  impactLead: (
    <>
      <strong>{t("group_actions.deactivate_warning")}</strong>{" "}
    </>
  ),
  impactTrail: <>{t("group_actions.deactivate_consequences_intro")}</>,
  titleKey: "group_actions.title_deactivate",
});

/** Admin reactivate-group confirmation page */
export const adminReactivateGroupPage = activateConfirmPage("groupReactivate", {
  body: <p>{t("group_actions.reactivate_benefits")}</p>,
  buttonText: t("group_actions.reactivate_confirm_button"),
  confirmPromptKey: "group_actions.reactivate_confirm_prompt",
  countPredicate: (e) => !e.active,
  danger: false,
  impactKey: "group_actions.reactivate_impact",
  titleKey: "group_actions.title_reactivate",
});
