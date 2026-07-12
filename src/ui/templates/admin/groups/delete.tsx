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
    confirm: {
      args: { name: `<strong>${group.name}</strong>`, slug: group.slug },
      key: "groups.delete.confirm",
    },
    danger: false,
    error,
    heading: t("groups.delete.heading"),
    label: t("groups.name_label"),
    name: group.name,
    note: { key: "groups.delete.listings_note" },
    prompt: {
      args: { name: group.name },
      key: "groups.delete.confirm_prompt",
    },
    session,
    title: t("groups.delete.heading"),
  });
