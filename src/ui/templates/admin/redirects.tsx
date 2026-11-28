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
  confirmDeleteSpec,
  defineRecordPages,
  deleteLinkColumn,
  recordPageConfig,
} from "#templates/admin/resource-pages.tsx";
import { getRedirectForm } from "#templates/fields/redirect.ts";

const redirectColumns = (): TableColumn<Redirect>[] => [
  ...fieldTableColumns(REDIRECT_FIELDS),
  deleteLinkColumn((redirect: Redirect) =>
    adminPath("redirectDelete", { id: redirect.id }),
  ),
];

/* jscpd:ignore-start -- static page config, not code */
const redirectList = {
  addLabelKey: "redirects.add_redirect",
  emptyKey: "redirects.none",
  guideAnchor: "settings",
  introKey: "redirects.intro",
  resource: "redirects",
  route: "redirectNew",
} as const;
/* jscpd:ignore-end */

export const getRedirectPages = (): AdminResourcePages<Redirect> =>
  defineRecordPages(
    redirectRecord,
    recordPageConfig(
      "redirects",
      redirectColumns(),
      redirectList,
      confirmDeleteSpec<Redirect>({
        confirmName: (redirect) => escapeHtml(redirect.fromPath),
        label: t("redirects.delete.confirm_label"),
        name: (redirect) => redirect.fromPath,
        resource: "redirects",
      }),
      () => <Raw html={getRedirectForm().render()} />,
    ),
  );
