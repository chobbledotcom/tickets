import type { ListingOverviewStats } from "#db/listing-overview-stats.ts";
import type { SystemNote } from "#db/notes/types.ts";
import { t } from "#i18n";
import {
  AttendeeNotesSummary,
  NotesSection,
} from "#templates/admin/attendee-notes.tsx";
import {
  buildStatDetailRows,
  calculateTotalRevenue,
  getCheckedInStats,
} from "#templates/admin/detail-rows.tsx";
import { ErrorNote } from "#templates/components/error.tsx";
import { PageRegions } from "#templates/components/page-structure.tsx";
import { type Attendee, isPaidListing, type ListingWithCount } from "#types";
import { attendeeStatsForListing } from "./attendees.tsx";
import { listingCapacityRowsFor } from "./capacity-rows.tsx";
import { ListingDetailsTable } from "./details.tsx";
import { attendeeCountLabelSuffix } from "./helpers.ts";
import { ListingIncomeLedgerSection } from "./ledger-section.tsx";
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

/** The listing page's banner: the deactivated alert, then the listing's
 * notes. The alert leads because it speaks about the record as a whole. The
 * notes follow it on every tab, so no note hides behind one. */
export const ListingBanner = ({
  active,
  deleteHref,
  isOwner,
  notes,
}: {
  active: boolean;
  deleteHref: (note: SystemNote) => string;
  isOwner: boolean;
  notes: SystemNote[];
}): JSX.Element => (
  <>
    {ListingDeactivatedBanner({ active })}
    {NotesSection({ deleteHref, isOwner, notes })}
  </>
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
    moneyTotals,
    ledgerHref,
    publicPage,
    systemNotes = [],
    isOwner,
  } = opts;
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
    ...(isPaidListing(listing) ? { revenue: stats.completeRevenue } : {}),
    labelSuffix: dailySuffix,
    questionData,
  });
  return (
    <PageRegions>
      <ListingDetailsTable
        aggregateRecalculation={aggregateRecalculation}
        allowedDomain={allowedDomain}
        capacity={capacity}
        listing={listing}
        publicPage={publicPage}
        sharedRows={sharedRows}
      />
      {moneyTotals && (
        <ListingIncomeLedgerSection
          breakdown={moneyTotals}
          ledgerHref={ledgerHref}
          listing={listing}
        />
      )}
      <AttendeeNotesSummary
        isOwner={isOwner}
        names={noteNames}
        notes={systemNotes}
      />
    </PageRegions>
  );
};
