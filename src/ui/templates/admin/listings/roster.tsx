import { map, mapBy, pipe } from "#fp";
import { attendeeLineRow } from "#shared/attendee-table-rows.ts";
import { isReadOnly } from "#shared/env.ts";
import { type Attendee, isPaidListing } from "#shared/types.ts";
import { AttendeeNotesSummary } from "#templates/admin/attendee-notes.tsx";
import { buildSharedDetailRows } from "#templates/admin/detail-rows.tsx";
import type { AttendeeTableRow } from "#templates/attendee-table.tsx";
import {
  AddAttendeeSection,
  AttendeesSection,
  attendeeStatsForListing,
  FailedPaymentsSection,
  filterAttendees,
  rosterHref,
} from "./attendees.tsx";
import {
  DailyCapacityDetailTable,
  listingCapacityRowsFor,
} from "./capacity-rows.tsx";
import { attendeeCountLabelSuffix } from "./helpers.ts";
import type { ListingPanelOptions } from "./types.ts";

const listingRosterView = (opts: ListingPanelOptions) => {
  const {
    listing,
    attendees,
    activeFilter = "all",
    dateFilter = null,
    questionData,
    paymentReferenceAttendeeIds = new Set(),
  } = opts;
  const isDaily = listing.listing_type === "daily";
  const hasPaidListing = isPaidListing(listing);
  const {
    incompleteAttendees,
    completeAttendees,
    adjustedCount,
    completeQuantitySum,
  } = attendeeStatsForListing(
    listing,
    attendees,
    hasPaidListing,
    paymentReferenceAttendeeIds,
  );
  const filteredAttendees = filterAttendees(completeAttendees, activeFilter);
  const dailySuffix = attendeeCountLabelSuffix(isDaily, dateFilter);
  const sharedRows = buildSharedDetailRows({
    attendeeCount: isDaily && dateFilter ? completeQuantitySum : adjustedCount,
    attendees: completeAttendees,
    hasPaidListing,
    labelSuffix: dailySuffix,
    maxCapacity: isDaily && !dateFilter ? 0 : listing.max_attendees,
    questionData,
    skipAttendees: true,
  });
  const basePath = `/admin/listing/${listing.id}`;
  const returnUrl = rosterHref(listing.id, activeFilter, dateFilter);
  const tableRows: AttendeeTableRow[] = pipe(
    map((a: Attendee): AttendeeTableRow => attendeeLineRow(a, listing)),
  )(filteredAttendees);
  return {
    activeFilter,
    adjustedCount,
    basePath,
    completeQuantitySum,
    dailySuffix,
    dateFilter,
    incompleteAttendees,
    isDaily,
    returnUrl,
    sharedRows,
    tableRows,
  };
};

export const ListingRosterPanel = (opts: ListingPanelOptions): JSX.Element => {
  const v = listingRosterView(opts);
  const {
    listing,
    allowedDomain,
    attendees = [],
    availableDates = [],
    phonePrefix,
    questionData,
    childNames = [],
    groupContext,
    systemNotes = [],
  } = opts;
  return (
    <>
      {DailyCapacityDetailTable({
        capacity: listingCapacityRowsFor(
          listing,
          v.isDaily,
          v.dateFilter,
          v.dailySuffix,
          v.adjustedCount,
          v.completeQuantitySum,
          groupContext,
        ),
        sharedRows: v.sharedRows,
      })}
      <AttendeeNotesSummary
        isOwner={opts.isOwner ?? false}
        names={mapBy("id", (attendee: Attendee) => attendee.name)(attendees)}
        notes={systemNotes}
      />
      <AttendeesSection
        activeFilter={v.activeFilter}
        allowedDomain={allowedDomain}
        availableDates={availableDates}
        basePath={v.basePath}
        dateFilter={v.dateFilter}
        isDaily={v.isDaily}
        listingId={listing.id}
        phonePrefix={phonePrefix}
        questionData={questionData}
        returnUrl={v.returnUrl}
        tableRows={v.tableRows}
      />
      {v.incompleteAttendees.length > 0 && (
        <FailedPaymentsSection
          attendees={v.incompleteAttendees}
          listingId={listing.id}
        />
      )}
      {!isReadOnly() && (
        <AddAttendeeSection childNames={childNames} listing={listing} />
      )}
    </>
  );
};
