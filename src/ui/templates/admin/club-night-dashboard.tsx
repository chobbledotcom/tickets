/**
 * The club night dashboard: the dashboard as a list of nights (groups). Each
 * night shows its listings on sale and the links an organiser opens on the
 * night. The owner turns it on as a feature. The full dashboard stays one link
 * away.
 */

import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import type { AdminDestinationId } from "#shared/admin-surface/ids.ts";
import { adminDestinationAllowed, adminPath } from "#shared/admin-surface.ts";
import {
  type ClubNight,
  type ClubNights,
  FULL_DASHBOARD_VIEW,
} from "#shared/club-nights.ts";
import { isReadOnly } from "#shared/env.ts";
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

/** One link under a night: where it goes, and the route that must admit the
 * viewer for the link to show. */
interface NightLink {
  readonly destination: AdminDestinationId;
  readonly href: string;
  readonly labelKey: string;
}

const nightLinks = (id: number): readonly NightLink[] => [
  {
    destination: "groupScanner",
    href: adminPath("groupScanner", { id }),
    labelKey: "admin.dashboard.night_scanner",
  },
  {
    destination: "group",
    href: `${adminPath("group", { id })}/attendees`,
    labelKey: "admin.dashboard.night_attendees",
  },
  {
    destination: "groupDuplicate",
    href: adminPath("groupDuplicate", { id }),
    labelKey: "admin.dashboard.night_duplicate",
  },
];

/** Keeps the links whose route admits this viewer, so no link is dead. */
const linksFor = (id: number, adminLevel: AdminLevel): NightLink[] =>
  nightLinks(id).filter((link) =>
    adminDestinationAllowed(link.destination, adminLevel, isReadOnly()),
  );

const NightBlock = ({
  adminLevel,
  night,
}: {
  adminLevel: AdminLevel;
  night: ClubNight;
}): JSX.Element => (
  <PageBlock>
    <h2>
      <a href={adminPath("group", { id: night.group.id })}>
        {night.group.name}
      </a>
    </h2>
    {configuredListingsTable(
      night.listings,
      t("admin.dashboard.night_no_listings"),
    )}
    <p class="actions">
      {linksFor(night.group.id, adminLevel).map((link) => (
        <ActionButton href={link.href} variant="outline">
          {t(link.labelKey)}
        </ActionButton>
      ))}
    </p>
  </PageBlock>
);

export const adminClubNightDashboardPage = ({
  clubNights,
  flash,
  listings,
  newestAttendees,
  pendingNotifications,
  session,
}: {
  clubNights: ClubNights;
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

      {clubNights.nights.map((night) => (
        <NightBlock adminLevel={session.adminLevel} night={night} />
      ))}

      {clubNights.otherListings.length > 0 && (
        <PageBlock>
          <h2>{t("admin.dashboard.other_listings")}</h2>
          {configuredListingsTable(
            clubNights.otherListings,
            t("admin.dashboard.no_listings"),
          )}
        </PageBlock>
      )}

      <Raw html={pendingNotificationsSection(pendingNotifications)} />

      <DashboardTail
        listings={listings}
        newestAttendees={newestAttendees}
        switchTo={{
          href: `/admin/?view=${FULL_DASHBOARD_VIEW}`,
          labelKey: "admin.dashboard.show_full",
        }}
      />
    </>,
    flash,
    session,
  );
