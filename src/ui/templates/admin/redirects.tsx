/**
 * Admin redirect page templates. The list, add, and delete pages come from
 * {@link defineRecordPages}. A redirect has no page of its own to edit.
 */

import type { Redirect } from "#db/redirects.ts";
import { t } from "#i18n";
import { escapeHtml } from "#jsx/escape-html.ts";
import { Raw } from "#jsx/jsx-runtime.ts";
import { adminPath } from "#shared/admin-surface.ts";
import { REDIRECT_FIELDS } from "#shared/records/redirect-fields.ts";
import { redirectRecord } from "#shared/records/redirects.ts";
import type { TableColumn } from "#shared/tables/column.ts";
import { fieldTableColumns } from "#templates/admin/field-columns.tsx";
import {
  type AdminResourcePages,
  defineRecordPages,
  listWithAddButton,
  pageLabels,
} from "#templates/admin/resource-pages.tsx";
import { WritableLink } from "#templates/admin/writable-only.tsx";
import { translatedTableColumn } from "#templates/components/translated-table-column.ts";
import { getRedirectForm } from "#templates/fields/redirect.ts";

const redirectColumns = (): TableColumn<Redirect>[] => [
  ...fieldTableColumns(REDIRECT_FIELDS),
  translatedTableColumn("actions", "common.actions", (redirect: Redirect) => (
    <WritableLink href={adminPath("redirectDelete", { id: redirect.id })}>
      {t("common.delete")}
    </WritableLink>
  )),
];

export const getRedirectPages = (): AdminResourcePages<Redirect> =>
  defineRecordPages(redirectRecord, {
    delete: {
      confirm: (redirect) => ({
        args: { name: escapeHtml(redirect.fromPath) },
        key: "redirects.delete.confirm",
      }),
      danger: true,
      label: t("redirects.delete.confirm_label"),
      name: (redirect) => redirect.fromPath,
      prompt: (redirect) => ({
        args: { name: redirect.fromPath },
        key: "redirects.delete.confirm_prompt",
      }),
    },
    labels: pageLabels("redirects"),
    list: listWithAddButton({
      add: { label: t("redirects.add_redirect"), route: "redirectNew" },
      columns: redirectColumns(),
      empty: t("redirects.none"),
      guide: { anchor: "settings", label: t("redirects.guide_link") },
      intro: <p>{t("redirects.intro")}</p>,
    }),
    renderFields: () => <Raw html={getRedirectForm().render()} />,
  });
