import { t } from "#i18n";
import { attendeeLineRow } from "#shared/attendee-table-rows.ts";
import {
  AttendeeTableBlock,
  attendeeTableOptions,
} from "#templates/admin/attendee-table-block.tsx";
import type { TableQuestionData } from "#templates/attendee-table/types.ts";
import type {
  Attendee,
  AttendeeTableRow,
  Group,
  ListingWithCount,
} from "#types";

/** Keep one row per booking line so each line has its own check-in button. */
const buildAttendeeRows = (
  attendees: Attendee[],
  listings: ListingWithCount[],
): AttendeeTableRow[] => {
  const listingMap = new Map(
    listings.map((listing) => [listing.id, listing] as const),
  );
  // These attendees are scoped to this group's loaded listings.
  return attendees.map((attendee) =>
    attendeeLineRow(attendee, listingMap.get(attendee.listing_id)!),
  );
};

/** The Attendees tab's booking lines across every listing in the group. */
export const GroupAttendeesPanel = ({
  group,
  listings,
  attendees,
  allowedDomain,
  phonePrefix,
  questionData,
}: {
  group: Group;
  listings: ListingWithCount[];
  attendees: Attendee[];
  allowedDomain: string;
  phonePrefix?: string;
  questionData?: TableQuestionData;
}): JSX.Element => (
  <article>
    <h2 id="attendees">{t("terms.attendees")}</h2>
    <AttendeeTableBlock
      options={attendeeTableOptions({
        allowedDomain,
        phonePrefix,
        questionData,
        returnUrl: `/admin/groups/${group.id}/attendees`,
        rows: buildAttendeeRows(attendees, listings),
        showDate: listings.some((listing) => listing.listing_type === "daily"),
        showListing: true,
      })}
    />
  </article>
);
