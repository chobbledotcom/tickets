import { t } from "#i18n";
import type { AdminSession, Group } from "#shared/types.ts";
import { ConfirmPage } from "#templates/admin/confirm-page.tsx";

/** Admin group delete confirmation page. */
export const adminGroupDeletePage = (
  group: Group,
  session: AdminSession,
  error?: string,
): string =>
  ConfirmPage({
    action: `/admin/groups/${group.id}/delete`,
    active: { section: "/admin/groups" },
    buttonText: t("groups.delete.submit"),
    children: (
      <>
        <h1>{t("groups.delete.heading")}</h1>
        <p>
          {t("groups.delete.confirm", {
            name: `<strong>${group.name}</strong>`,
            slug: group.slug,
          })}
        </p>
        <p>
          Listings in this group will not be deleted -- they will be moved out
          of the group.
        </p>
        <p>Type the group name "{group.name}" to confirm:</p>
      </>
    ),
    danger: false,
    error,
    label: t("groups.name_label"),
    name: group.name,
    session,
    title: t("groups.delete.heading"),
  });
