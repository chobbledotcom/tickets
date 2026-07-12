import { t } from "#i18n";
import { entityReturnPath } from "#shared/admin-pages.ts";
import type { AdminSession, Group } from "#shared/types.ts";
import { successAdminPage } from "#templates/admin/admin-page.tsx";
import { GuideFooter } from "#templates/components/actions.tsx";
import { DataTable } from "#templates/components/data-table.tsx";

/** Admin groups list page. */
export const adminGroupsPage = (
  groups: Group[],
  session: AdminSession,
  successMessage?: string,
): string =>
  successAdminPage(t("terms.groups"), "/admin/groups")(session, successMessage)(
    <>
      {groups.length === 0 ? (
        <p>{t("groups.no_groups")}</p>
      ) : (
        // Staff open the detail page; editors can't (it decrypts attendee PII),
        // so they link straight to the edit form.
        <DataTable
          columns={[{ header: t("common.name") }, { header: t("common.slug") }]}
          rows={groups.map((group) => [
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
      )}

      <GuideFooter adminLevel={session.adminLevel} href="/admin/guide#packages">
        {t("groups.guide_link")}
      </GuideFooter>
    </>,
  );
