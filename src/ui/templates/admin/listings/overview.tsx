import { t } from "#i18n";
import type { ListingOverviewStats } from "#shared/db/listing-overview-stats.ts";
import {
  type Attendee,
  isPaidListing,
  type ListingWithCount,
} from "#shared/types.ts";
import { AttendeeNotesSummary } from "#templates/admin/attendee-notes.tsx";
import {
  buildStatDetailRows,
  calculateTotalRevenue,
  getCheckedInStats,
  renderDetailRows,
} from "#templates/admin/detail-rows.tsx";
import { ErrorNote } from "#templates/components/error.tsx";
import { PageRegions } from "#templates/components/page-structure.tsx";
import { attendeeStatsForListing } from "./attendees.tsx";
import { listingCapacityRowsFor } from "./capacity-rows.tsx";
import { ListingDetailsTable } from "./details.tsx";
import { attendeeCountLabelSuffix, listingLinksFor } from "./helpers.ts";
import {
  ListingIncomeLedgerSection,
  ListingLedgerSection,
} from "./ledger-section.tsx";
import type { ListingOverviewPanelOptions, OverviewStats } from "./types.ts";

export type { ListingOverviewPanelOptions, OverviewStats } from "./types.ts";

export const ListingDeactivatedBanner = ({
  active,
}: {
  active: boolean;
}): JSX.Element | null =>
  active ? null : (
    <ErrorNote>{t("listings_table.listing_deactivated_warning")}</ErrorNote>
  );

export const overviewStatsFromAttendees = (
  listing: ListingWithCount,
  attendees: Attendee[],
  paymentReferenceAttendeeIds?: ReadonlySet<number>,
): OverviewStats => {
  const hasPaidListing = isPaidListing(listing);
  const { adjustedCount, completeQuantitySum, completeAttendees } =
    attendeeStatsForListing(
      listing,
      attendees,
      hasPaidListing,
      paymentReferenceAttendeeIds ?? new Set(),
    );
  return {
    adjustedCount,
    checkedInStats: getCheckedInStats(completeAttendees),
    completeQuantitySum,
    completeRevenue: hasPaidListing
      ? calculateTotalRevenue(completeAttendees)
      : 0,
  };
};

export const overviewStatsFromDbStats = (
  stats: ListingOverviewStats,
  attendeeCount: number,
  grossSales: number,
  hasPaidListing: boolean,
): OverviewStats => ({
  adjustedCount: attendeeCount - stats.incompleteQuantity,
  checkedInStats: {
    hasMultiQuantity: stats.ticketsTotal !== stats.rowsTotal,
    rowsCheckedIn: stats.rowsCheckedIn,
    rowsTotal: stats.rowsTotal,
    ticketsCheckedIn: stats.ticketsCheckedIn,
    ticketsTotal: stats.ticketsTotal,
  },
  completeQuantitySum: stats.completeQuantitySum,
  completeRevenue: hasPaidListing ? grossSales - stats.incompleteSales : 0,
});

export const ListingOverviewPanel = (
  opts: ListingOverviewPanelOptions,
): JSX.Element => {
  const {
    listing,
    allowedDomain,
    stats,
    noteNames,
    aggregateRecalculation,
    questionData,
    groupContext,
    revenueBreakdown,
    ledger,
    ledgerHref,
    isChild = false,
    isHiddenPackageMember = false,
    systemNotes = [],
  } = opts;
  const links = listingLinksFor(listing, allowedDomain);
  const isDaily = listing.listing_type === "daily";
  const dailySuffix = attendeeCountLabelSuffix(isDaily, null);
  const capacity = listingCapacityRowsFor(
    listing,
    isDaily,
    null,
    dailySuffix,
    stats.adjustedCount,
    stats.completeQuantitySum,
    groupContext,
  );
  const sharedRows = buildStatDetailRows({
    checkedInStats: stats.checkedInStats,
    hasPaidListing: isPaidListing(listing),
    revenue: stats.completeRevenue,
    ...(questionData !== undefined ? { questionData } : {}),
    labelSuffix: dailySuffix,
  });
  return (
    <PageRegions>
      <ListingDetailsTable
        aggregateRecalculation={aggregateRecalculation}
        allowedDomain={allowedDomain}
        capacity={capacity}
        embedIframeCode={links.embedIframeCode}
        embedScriptCode={links.embedScriptCode}
        isChild={isChild}
        isHiddenPackageMember={isHiddenPackageMember}
        listing={listing}
        sharedRowsHtml={renderDetailRows(sharedRows)}
        ticketUrl={links.ticketUrl}
      />
      {revenueBreakdown && (
        <ListingIncomeLedgerSection
          breakdown={revenueBreakdown}
          ledgerHref={ledgerHref}
          listing={listing}
        />
      )}
      {ledger && (
        <ListingLedgerSection ledger={ledger} listingId={listing.id} />
      )}
      <AttendeeNotesSummary names={noteNames} notes={systemNotes} />
    </PageRegions>
  );
};
