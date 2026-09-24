import { t } from "#i18n";
import { ConfirmPage } from "#templates/admin/confirm-page.tsx";
import type { AdminSession, Group, ListingWithCount } from "#types";

/** Confirmation page for removing listings from a group: the chosen members,
 * what happens to their bookings and prices, and the group's name to type. */
export const adminGroupRemoveListingsPage = (
  { group, listings }: { group: Group; listings: ListingWithCount[] },
  session: AdminSession,
  error?: string,
): string =>
  ConfirmPage({
    action: `/admin/groups/${group.id}/remove-listings`,
    active: { section: "/admin/groups" },
    buttonText: t("groups.remove.submit"),
    children: <TheChosenMembers listings={listings} />,
    error,
    hiddenFields: { listing_ids: listings.map(({ id }) => id).join(",") },
    label: t("groups.name_label"),
    name: group.name,
    prompt: { args: { name: group.name }, key: "groups.remove.confirm_prompt" },
    session,
    title: t("groups.remove.heading"),
    warning: (
      <div class="warning">{t("groups.detail.remove_listings_warning")}</div>
    ),
  });

/** The members the operator chose, by name. */
const TheChosenMembers = ({ listings }: { listings: ListingWithCount[] }) => (
  <ul>
    {listings.map(({ id, name }) => (
      <li key={id}>{name}</li>
    ))}
  </ul>
);
