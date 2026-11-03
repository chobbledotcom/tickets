/* jscpd:ignore-start */
import { t } from "#i18n";
import { entityReturnPath } from "#shared/admin-pages.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import type { TableColumn } from "#shared/tables/column.ts";
import { successListPage } from "#templates/admin/admin-page.tsx";
import { guideFooterFor } from "#templates/components/actions.tsx";
import { translatedTableColumn } from "#templates/components/translated-table-column.ts";
import type { Group } from "#types";

/* jscpd:ignore-end */

const groupLink = (group: Group): JSX.Element => (
  <a href={entityReturnPath(adminPattern("groups"), group.id)}>{group.name}</a>
);

const groupColumns: readonly TableColumn<Group>[] = [
  translatedTableColumn("name", "common.name", groupLink),
  translatedTableColumn("slug", "common.slug", (group) => group.slug),
];

/** Admin groups list page. */
export const adminGroupsPage = successListPage<Group>(
  "terms.groups",
  adminPattern("groups"),
  (groups, session) => ({
    columns: groupColumns,
    empty: <p>{t("groups.no_groups")}</p>,
    guideFooter: guideFooterFor(
      "/admin/guide#packages",
      "groups.guide_link",
      session.adminLevel,
    ),
    items: groups,
  }),
);
