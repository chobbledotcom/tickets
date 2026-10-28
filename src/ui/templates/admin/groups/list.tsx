/* jscpd:ignore-start */
import { t } from "#i18n";
import { entityReturnPath } from "#shared/admin-pages.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import type { TableColumn } from "#shared/tables/column.ts";
import { renderAdminPageSpec } from "#templates/admin/admin-page-spec.tsx";
import { GuideFooter } from "#templates/components/actions.tsx";
import { translatedTableColumn } from "#templates/components/translated-table-column.ts";
import type { AdminSession, Group } from "#types";

/* jscpd:ignore-end */

const groupLink = (group: Group): JSX.Element => (
  <a href={entityReturnPath(adminPattern("groups"), group.id)}>{group.name}</a>
);

const groupColumns: readonly TableColumn<Group>[] = [
  translatedTableColumn("name", "common.name", groupLink),
  translatedTableColumn("slug", "common.slug", (group) => group.slug),
];

/** Admin groups list page. */
export const adminGroupsPage = (
  groups: Group[],
  session: AdminSession,
  successMessage?: string,
): string =>
  renderAdminPageSpec({
    active: adminPattern("groups"),
    flash: { success: successMessage },
    list: {
      columns: groupColumns,
      empty: <p>{t("groups.no_groups")}</p>,
      guideFooter: (
        <GuideFooter
          adminLevel={session.adminLevel}
          href="/admin/guide#packages"
        >
          {t("groups.guide_link")}
        </GuideFooter>
      ),
      items: groups,
    },
    session,
    title: t("terms.groups"),
  });
