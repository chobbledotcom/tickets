import { t } from "#i18n";
import type { DetailRow } from "#templates/admin/detail-rows.tsx";
import {
  CapacityMeter,
  capacityLevel,
  GroupCapacityMeter,
} from "#templates/components/capacity.tsx";
import { DetailTable } from "#templates/components/detail-table.tsx";
import { LabelledRow } from "#templates/components/labelled-row.tsx";
import type { ListingWithCount } from "#types";
import type { GroupContext } from "./types.ts";

export type ListingCapacityRowsProps = {
  listing: ListingWithCount;
  isDaily: boolean;
  dateFilter: string | null;
  dailySuffix: string;
  adjustedCount: number;
  completeQuantitySum: number;
  groupContext?: GroupContext | undefined;
};

type AttendeeCountDisplayProps = Omit<
  ListingCapacityRowsProps,
  "dailySuffix" | "groupContext"
>;

export const listingCapacityRowsFor = (
  listing: ListingWithCount,
  isDaily: boolean,
  dateFilter: string | null,
  dailySuffix: string,
  adjustedCount: number,
  completeQuantitySum: number,
  groupContext: GroupContext | undefined,
): ListingCapacityRowsProps => ({
  adjustedCount,
  completeQuantitySum,
  dailySuffix,
  dateFilter,
  groupContext,
  isDaily,
  listing,
});

const AttendeeCountDisplay = (
  props: AttendeeCountDisplayProps,
): JSX.Element => {
  const { listing, isDaily, dateFilter, adjustedCount, completeQuantitySum } =
    props;
  if (isDaily && dateFilter) {
    return (
      <CapacityMeter
        count={completeQuantitySum}
        danger={
          capacityLevel(completeQuantitySum, listing.maxAttendees).overLimit
        }
        max={listing.maxAttendees}
      />
    );
  }
  const level = capacityLevel(adjustedCount, listing.maxAttendees);
  if (isDaily) {
    return (
      <span class={level.nearLimit ? "danger-text" : ""}>{adjustedCount}</span>
    );
  }
  return (
    <CapacityMeter
      count={adjustedCount}
      danger={level.nearLimit}
      max={listing.maxAttendees}
    />
  );
};

/** A capacity row's label: the row's own name plus the "(this date)" suffix
 * daily listings add. */
const capacityRowLabel = (
  labelKey: string,
  dailySuffix: string,
): JSX.Element => (
  <>
    {t(labelKey)}
    {dailySuffix}
  </>
);

type AttendeesSummaryRowProps = Omit<ListingCapacityRowsProps, "groupContext">;

export const AttendeesSummaryRow = (
  props: AttendeesSummaryRowProps,
): JSX.Element => (
  <LabelledRow
    label={capacityRowLabel(
      "listings_table.listing_attendees",
      props.dailySuffix,
    )}
  >
    <AttendeeCountDisplay {...props} />
    {props.isDaily && !props.dateFilter && (
      <>
        {" "}
        <small>
          {t("listings_table.capacity_per_date", {
            capacity: props.listing.maxAttendees,
          })}
        </small>
      </>
    )}
  </LabelledRow>
);

export const GroupAttendeesRow = ({
  group,
  groupAttendeeCount,
  dailySuffix,
}: {
  group: GroupContext["group"];
  groupAttendeeCount: number;
  dailySuffix: string;
}): JSX.Element => (
  <LabelledRow
    label={capacityRowLabel("listings_table.group_attendees", dailySuffix)}
  >
    <GroupCapacityMeter count={groupAttendeeCount} max={group.maxAttendees} />{" "}
    <small>
      {t("listings_table.across_all_listings_in")}{" "}
      <a href={`/admin/groups/${group.id}`}>{group.name}</a>
    </small>
  </LabelledRow>
);

export const ListingCapacityRows = (
  props: ListingCapacityRowsProps,
): JSX.Element => (
  <>
    <AttendeesSummaryRow {...props} />
    {props.groupContext && (
      <GroupAttendeesRow
        dailySuffix={props.dailySuffix}
        group={props.groupContext.group}
        groupAttendeeCount={props.groupContext.attendeeCount}
      />
    )}
  </>
);

export const DailyCapacityDetailTable = ({
  capacity,
  sharedRows,
}: {
  capacity: ListingCapacityRowsProps;
  sharedRows: DetailRow[];
}): JSX.Element | null => {
  if (capacity.listing.listingType !== "daily" || !capacity.dateFilter) {
    return null;
  }
  return (
    <DetailTable rows={sharedRows}>
      <ListingCapacityRows {...capacity} />
    </DetailTable>
  );
};
