import { t } from "#i18n";
import { entityReturnPath } from "#shared/admin-pages.ts";
import type { Group } from "#shared/types.ts";
import { successListPage } from "#templates/admin/admin-page.tsx";
import { GuideFooter } from "#templates/components/actions.tsx";
import {
  CollectionTable,
  namedColumns,
} from "#templates/components/data-table.tsx";

/** Admin groups list page. */
export const adminGroupsPage = successListPage<Group[]>(
  "terms.groups",
  "/admin/groups",
  (groups, session) => (
    <>
      <CollectionTable
        columns={namedColumns("common.slug")}
        emptyKey="groups.no_groups"
        items={groups}
        rows={groups.map((group) => [
          // Staff open the detail page; editors can't (it decrypts attendee
          // PII), so they link straight to the edit form.
          <a
            href={entityReturnPath(
              "/admin/groups",
              session.adminLevel,
              group.id,
            )}
          >
            {group.name}
          </a>,
          group.slug,
        ])}
      />

      <GuideFooter adminLevel={session.adminLevel} href="/admin/guide#packages">
        {t("groups.guide_link")}
      </GuideFooter>
    </>
  ),
);
