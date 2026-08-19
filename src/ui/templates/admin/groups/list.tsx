/* jscpd:ignore-start */
import { t } from "#i18n";
import { entityReturnPath } from "#shared/admin-pages.ts";
import type { TableColumn } from "#shared/tables/column.ts";
import { defineTable } from "#shared/tables/definition.ts";
import type { AdminSession, Group } from "#shared/types.ts";
import { successListPage } from "#templates/admin/admin-page.tsx";
import { GuideFooter } from "#templates/components/actions.tsx";
import { itemsOrEmptyNote } from "#templates/components/reorder-list.tsx";
import { renderTable } from "#templates/components/table.tsx";
import { translatedTableHeader } from "#templates/components/translated-table-column.ts";

/* jscpd:ignore-end */

const groupLink = (group: Group): JSX.Element => (
  <a href={entityReturnPath("/admin/groups", group.id)}>{group.name}</a>
);

const groupColumns: readonly TableColumn<Group, AdminSession["adminLevel"]>[] =
  [
    {
      cell: groupLink,
      header: translatedTableHeader("common.name"),
      key: "name",
    },
    {
      cell: (group) => group.slug,
      header: translatedTableHeader("common.slug"),
      key: "slug",
    },
  ];

const groupsTable = defineTable(groupColumns);

/** Admin groups list page. */
export const adminGroupsPage = successListPage<Group[]>(
  "terms.groups",
  "/admin/groups",
  (groups, session) => (
    <>
      {itemsOrEmptyNote(groups, t("groups.no_groups"), (rows) =>
        renderTable(groupsTable, rows, { context: session.adminLevel }),
      )}

      <GuideFooter adminLevel={session.adminLevel} href="/admin/guide#packages">
        {t("groups.guide_link")}
      </GuideFooter>
    </>
  ),
);
