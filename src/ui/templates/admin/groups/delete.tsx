import { t } from "#i18n";
import { escapeHtml } from "#shared/jsx/escape-html.ts";
import type { Group } from "#shared/types.ts";
import { entityDeletePage } from "#templates/admin/confirm-page.tsx";

/** Admin group delete confirmation page. */
export const adminGroupDeletePage = entityDeletePage((group: Group) => ({
  action: `/admin/groups/${group.id}/delete`,
  active: { section: "/admin/groups" },
  buttonText: t("groups.delete.submit"),
  confirm: {
    args: {
      name: `<strong>${escapeHtml(group.name)}</strong>`,
      slug: escapeHtml(group.slug),
    },
    key: "groups.delete.confirm",
  },
  danger: false,
  heading: t("groups.delete.heading"),
  label: t("groups.name_label"),
  name: group.name,
  note: { key: "groups.delete.listings_note" },
  prompt: {
    args: { name: group.name },
    key: "groups.delete.confirm_prompt",
  },
  title: t("groups.delete.heading"),
}));
