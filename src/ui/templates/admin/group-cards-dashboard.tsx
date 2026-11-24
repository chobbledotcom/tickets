/**
 * The group cards dashboard: the admin home page as one card for each group.
 * Each card shows the group's listings on sale and the links an organiser
 * opens on the day. The owner chooses it as the dashboard type. The listings
 * table stays one link away.
 */

import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import type { AdminDestinationId } from "#shared/admin-surface/ids.ts";
import { adminDestinationAllowed, adminPath } from "#shared/admin-surface.ts";
import { isReadOnly } from "#shared/env.ts";
import {
  type GroupCard,
  type GroupCards,
  LISTINGS_TABLE_VIEW,
} from "#shared/group-cards.ts";
import {
  DashboardQuickActions,
  DashboardTail,
  pendingNotificationsSection,
  renderDashboard,
} from "#templates/admin/dashboard.tsx";
import { configuredListingsTable } from "#templates/admin/listing-table.tsx";
import { ActionButton } from "#templates/components/actions.tsx";
import { PageBlock } from "#templates/components/page-structure.tsx";
import type {
  AdminLevel,
  AdminSession,
  DisplayAttendee,
  ListingWithCount,
} from "#types";

/** One link on a card: where it goes, and the route that must admit the
 * viewer for the link to show. */
interface CardLink {
  readonly destination: AdminDestinationId;
  readonly href: string;
  readonly labelKey: string;
}

const cardLinks = (id: number): readonly CardLink[] => [
  {
    destination: "groupScanner",
    href: adminPath("groupScanner", { id }),
    labelKey: "admin.dashboard.card_scanner",
  },
  {
    destination: "group",
    href: `${adminPath("group", { id })}/attendees`,
    labelKey: "admin.dashboard.card_attendees",
  },
  {
    destination: "groupDuplicate",
    href: adminPath("groupDuplicate", { id }),
    labelKey: "admin.dashboard.card_duplicate",
  },
];

/** Keeps the links whose route admits this viewer, so no link is dead. */
const linksFor = (id: number, adminLevel: AdminLevel): CardLink[] =>
  cardLinks(id).filter((link) =>
    adminDestinationAllowed(link.destination, adminLevel, isReadOnly()),
  );

const GroupCardBlock = ({
  adminLevel,
  card,
}: {
  adminLevel: AdminLevel;
  card: GroupCard;
}): JSX.Element => (
  <PageBlock>
    <h2>
      <a href={adminPath("group", { id: card.group.id })}>{card.group.name}</a>
    </h2>
    {configuredListingsTable(
      card.listings,
      t("admin.dashboard.card_no_listings"),
    )}
    <p class="actions">
      {linksFor(card.group.id, adminLevel).map((link) => (
        <ActionButton href={link.href} variant="outline">
          {t(link.labelKey)}
        </ActionButton>
      ))}
    </p>
  </PageBlock>
);

export const adminGroupCardsDashboardPage = ({
  groupCards,
  flash,
  listings,
  newestAttendees,
  pendingNotifications,
  session,
}: {
  groupCards: GroupCards;
  flash: { error?: string | undefined; success?: string | undefined };
  /** Every listing in order, which names the newest attendees' listings. */
  listings: ListingWithCount[];
  newestAttendees: DisplayAttendee[];
  pendingNotifications: number;
  session: AdminSession;
}): string =>
  renderDashboard(
    <>
      {!isReadOnly() && <DashboardQuickActions />}

      {groupCards.cards.map((card) => (
        <GroupCardBlock adminLevel={session.adminLevel} card={card} />
      ))}

      {groupCards.otherListings.length > 0 && (
        <PageBlock>
          <h2>{t("admin.dashboard.other_listings")}</h2>
          {configuredListingsTable(
            groupCards.otherListings,
            t("admin.dashboard.no_listings"),
          )}
        </PageBlock>
      )}

      <Raw html={pendingNotificationsSection(pendingNotifications)} />

      <DashboardTail
        listings={listings}
        newestAttendees={newestAttendees}
        switchTo={{
          href: `/admin/?view=${LISTINGS_TABLE_VIEW}`,
          labelKey: "admin.dashboard.show_listings_table",
        }}
      />
    </>,
    flash,
    session,
  );
