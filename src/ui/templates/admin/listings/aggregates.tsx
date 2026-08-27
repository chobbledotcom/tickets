/* jscpd:ignore-start */

import type {
  ListingAggregateField,
  ListingAggregateRecalculation,
} from "#db/listings/aggregates.ts";
import { t } from "#i18n";
import { adminPath } from "#shared/admin-surface.ts";
import { isReadOnly } from "#shared/env.ts";
import type { FieldValues } from "#shared/forms/values.ts";
import {
  driftedRowItems,
  ExpectedActualNotice,
  ExpectedActualTableRow,
} from "#templates/admin/expected-actual.tsx";
import { recalculateRowsFor } from "#templates/admin/recalculate-rows.ts";
import {
  bindRecalculatePage,
  recalculatePageRenderer,
} from "#templates/components/aggregate-sections.tsx";
import { capacityLevel } from "#templates/components/capacity.tsx";
import { getListingAggregateFields } from "#templates/fields/aggregate.ts";
import type { ListingWithCount } from "#types";

/* jscpd:ignore-end */

export {
  calculateTotalRevenue,
  countCheckedIn,
  countCheckedInRows,
  sumQuantity,
} from "#templates/admin/detail-rows.tsx";

export const nearCapacity = (listing: ListingWithCount): boolean =>
  capacityLevel(listing.attendee_count, listing.max_attendees).nearLimit;

const listingRecalculateRows = recalculateRowsFor<ListingAggregateField>(
  getListingAggregateFields,
);

/** The drift-notice copy plus the drifted running totals; the "fix it" link is
 * included only when a recalculate page is reachable. Shared by the inline
 * notice and the listing table row. */
const listingAggregateNotice = (
  aggregateRecalculation: ListingAggregateRecalculation | undefined,
  actionHref?: string,
): Parameters<typeof ExpectedActualNotice>[0] => ({
  ...(actionHref
    ? {
        actionHref,
        actionLabel: t("listings_table.running_totals_error_action"),
      }
    : {}),
  explanation: t("listings_table.running_totals_error_explanation"),
  items: aggregateRecalculation
    ? driftedRowItems(listingRecalculateRows(aggregateRecalculation))
    : [],
  title: t("listings_table.running_totals_error_title"),
});

export const ListingAggregateMismatchNotice = ({
  aggregateRecalculation,
  actionHref,
}: {
  aggregateRecalculation?: ListingAggregateRecalculation | undefined;
  actionHref?: string | undefined;
}): JSX.Element | null =>
  ExpectedActualNotice(
    listingAggregateNotice(aggregateRecalculation, actionHref),
  );

/** A listing plus its (optional) running-total drift snapshot. */
type ListingAggregateProps = {
  aggregateRecalculation?: ListingAggregateRecalculation | undefined;
  listing: ListingWithCount;
};

export const ListingAggregateMismatchRow = ({
  aggregateRecalculation,
  listing,
}: ListingAggregateProps): JSX.Element | null =>
  ExpectedActualTableRow({
    header: t("listings_table.running_total_check"),
    notice: listingAggregateNotice(
      aggregateRecalculation,
      isReadOnly()
        ? undefined
        : adminPath("listingRecalculate", { listingId: listing.id }),
    ),
  });

export const listingAggregateToFieldValues = (
  listing: ListingWithCount,
): FieldValues => ({
  booked_quantity: listing.attendee_count,
  tickets_count: listing.tickets_count,
});

const listingRecalculateRenderer = (
  listing: ListingWithCount,
  snapshot: ListingAggregateRecalculation,
) =>
  recalculatePageRenderer({
    action: `/admin/listings/recalculate/${listing.id}`,
    active: "/admin/",
    currentLabel: t("listings_table.recalculate_current"),
    description: t("listings_table.recalculate_description"),
    recalculatedLabel: t("listings_table.recalculate_from_attendees"),
    rows: listingRecalculateRows(snapshot),
    submitLabel: t("listings_table.recalculate_save"),
    title: t("listings_table.recalculate_listing_title", {
      name: listing.name,
    }),
  });

export const adminListingRecalculatePage = bindRecalculatePage(
  listingRecalculateRenderer,
);
