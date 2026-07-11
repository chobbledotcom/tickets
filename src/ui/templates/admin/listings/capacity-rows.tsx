import { t } from "#i18n";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { ListingWithCount } from "#shared/types.ts";
import {
  CapacityMeter,
  capacityLevel,
  GroupCapacityMeter,
} from "#templates/components/capacity.tsx";
import { DetailTable } from "#templates/components/detail-table.tsx";
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
          capacityLevel(completeQuantitySum, listing.max_attendees).overLimit
        }
        max={listing.max_attendees}
      />
    );
  }
  const level = capacityLevel(adjustedCount, listing.max_attendees);
  if (isDaily) {
    return (
      <span class={level.nearLimit ? "danger-text" : ""}>{adjustedCount}</span>
    );
  }
  return (
    <CapacityMeter
      count={adjustedCount}
      danger={level.nearLimit}
      max={listing.max_attendees}
    />
  );
};

type AttendeesSummaryRowProps = Omit<ListingCapacityRowsProps, "groupContext">;

export const AttendeesSummaryRow = (
  props: AttendeesSummaryRowProps,
): JSX.Element => (
  <tr>
    <th>
      {t("listings_table.listing_attendees")}
      {props.dailySuffix}
    </th>
    <td>
      <AttendeeCountDisplay {...props} />
      {props.isDaily && !props.dateFilter && (
        <>
          {" "}
          <small>
            {t("listings_table.capacity_per_date", {
              capacity: props.listing.max_attendees,
            })}
          </small>
        </>
      )}
    </td>
  </tr>
);

export const GroupAttendeesRow = ({
  group,
  groupAttendeeCount,
  dailySuffix,
}: {
  group: GroupContext["group"];
  groupAttendeeCount: number;
  dailySuffix: string;
}): JSX.Element => {
  return (
    <tr>
      <th>
        {t("listings_table.group_attendees")}
        {dailySuffix}
      </th>
      <td>
        <GroupCapacityMeter
          count={groupAttendeeCount}
          max={group.max_attendees}
        />{" "}
        <small>
          {t("listings_table.across_all_listings_in")}{" "}
          <a href={`/admin/groups/${group.id}`}>{group.name}</a>
        </small>
      </td>
    </tr>
  );
};

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
  sharedRowsHtml,
}: {
  capacity: ListingCapacityRowsProps;
  sharedRowsHtml: string;
}): JSX.Element | null => {
  if (capacity.listing.listing_type !== "daily" || !capacity.dateFilter) {
    return null;
  }
  return (
    <DetailTable>
      <ListingCapacityRows {...capacity} />
      <Raw html={sharedRowsHtml} />
    </DetailTable>
  );
};
