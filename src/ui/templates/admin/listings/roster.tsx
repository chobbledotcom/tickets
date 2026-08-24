import { fieldById, map, pipe } from "#fp";
import {
  attendeeListHref,
  inRegistrationOrder,
} from "#shared/attendee-list-controls.ts";
import { attendeeLineRow } from "#shared/attendee-table-rows.ts";
import { isReadOnly } from "#shared/env.ts";
import { AttendeeNotesSummary } from "#templates/admin/attendee-notes.tsx";
import { buildSharedDetailRows } from "#templates/admin/detail-rows.tsx";
import { type Attendee, type AttendeeTableRow, isPaidListing } from "#types";
import {
  AddAttendeeSection,
  AttendeesSection,
  attendeeStatsForListing,
  emailDayHrefFor,
  FailedPaymentsSection,
  filterAttendees,
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
    list,
    questionData,
    paymentReferenceAttendeeIds = new Set(),
  } = opts;
  const { checkin, date: dateFilter, sort } = list.state;
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
  const filteredAttendees = filterAttendees(completeAttendees, checkin);
  // A chosen sort orders the rows here; otherwise the table applies its own
  // date-and-name order.
  const orderedAttendees =
    sort === null
      ? filteredAttendees
      : inRegistrationOrder(sort)(filteredAttendees);
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
  const returnUrl = attendeeListHref(list.setup, list.state);
  const tableRows: AttendeeTableRow[] = pipe(
    map((a: Attendee): AttendeeTableRow => attendeeLineRow(a, listing)),
  )(orderedAttendees);
  return {
    adjustedCount,
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
    list,
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
        isOwner={opts.isOwner}
        names={fieldById("name")(attendees)}
        notes={systemNotes}
      />
      <AttendeesSection
        allowedDomain={allowedDomain}
        emailDayHref={emailDayHrefFor(
          listing.id,
          v.dateFilter,
          opts.isOwner,
          attendees,
        )}
        list={list}
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
