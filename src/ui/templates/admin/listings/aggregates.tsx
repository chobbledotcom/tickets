import { t } from "#i18n";
import type {
  ListingAggregateField,
  ListingAggregateRecalculation,
} from "#shared/db/listings.ts";
import type { FieldValues } from "#shared/forms.tsx";
import type { AdminSession, ListingWithCount } from "#shared/types.ts";
import {
  buildAnswerSummaryRows as buildAnswerSummaryDetailRows,
  renderDetailRows,
} from "#templates/admin/detail-rows.tsx";
import {
  type ExpectedActualItem,
  ExpectedActualNotice,
  ExpectedActualTableRow,
} from "#templates/admin/expected-actual.tsx";
import type { RecalculateRow } from "#templates/admin/recalculate.tsx";
import type { TableQuestionData } from "#templates/attendee-table.tsx";
import { recalculatePageRenderer } from "#templates/components/aggregate-sections.tsx";
import { listingAggregateFields } from "#templates/fields.ts";

export {
  calculateTotalRevenue,
  countCheckedIn,
  countCheckedInRows,
  sumQuantity,
} from "#templates/admin/detail-rows.tsx";
export { formatAddressInline } from "#templates/attendee-table.tsx";

export const buildAnswerSummaryRows = (
  questionData: TableQuestionData | undefined,
): string => renderDetailRows(buildAnswerSummaryDetailRows(questionData));

export const nearCapacity = (listing: ListingWithCount): boolean =>
  listing.attendee_count >= listing.max_attendees * 0.9;

const listingAggregateFormatters: Record<
  ListingAggregateField,
  (value: number) => string
> = {
  booked_quantity: String,
  tickets_count: String,
};

const formatListingAggregateValue = (
  name: ListingAggregateField,
  value: number,
): string => listingAggregateFormatters[name](value);

const listingAggregateMismatchItems = (
  aggregateRecalculation?: ListingAggregateRecalculation | undefined,
): ExpectedActualItem[] => {
  if (!aggregateRecalculation) return [];
  return listingAggregateFields.flatMap((field) => {
    const name = field.name as ListingAggregateField;
    const values = aggregateRecalculation[name];
    return values.current === values.recalculated
      ? []
      : [
          {
            actual: formatListingAggregateValue(name, values.current),
            expected: formatListingAggregateValue(name, values.recalculated),
            label: field.label,
          },
        ];
  });
};

export const ListingAggregateMismatchNotice = ({
  aggregateRecalculation,
  actionHref,
}: {
  aggregateRecalculation?: ListingAggregateRecalculation | undefined;
  actionHref: string;
}): JSX.Element | null => {
  const items = listingAggregateMismatchItems(aggregateRecalculation);
  return (
    <ExpectedActualNotice
      actionHref={actionHref}
      actionLabel={t("listings_table.running_totals_error_action")}
      explanation={t("listings_table.running_totals_error_explanation")}
      items={items}
      title={t("listings_table.running_totals_error_title")}
    />
  );
};

export const ListingAggregateMismatchRow = ({
  aggregateRecalculation,
  listing,
}: {
  aggregateRecalculation?: ListingAggregateRecalculation | undefined;
  listing: ListingWithCount;
}): JSX.Element | null => {
  const items = listingAggregateMismatchItems(aggregateRecalculation);
  return ExpectedActualTableRow({
    header: t("listings_table.running_total_check"),
    notice: {
      actionHref: `/admin/listings/recalculate/${listing.id}`,
      actionLabel: t("listings_table.running_totals_error_action"),
      explanation: t("listings_table.running_totals_error_explanation"),
      items,
      title: t("listings_table.running_totals_error_title"),
    },
  });
};

export const listingAggregateToFieldValues = (
  listing: ListingWithCount,
): FieldValues => ({
  booked_quantity: listing.attendee_count,
  tickets_count: listing.tickets_count,
});

const listingRecalculateRows = (
  snapshot: ListingAggregateRecalculation,
): RecalculateRow[] =>
  listingAggregateFields.map((field) => {
    const name = field.name as ListingAggregateField;
    return {
      current: listingAggregateFormatters[name](snapshot[name].current),
      label: field.label,
      name,
      recalculated: listingAggregateFormatters[name](
        snapshot[name].recalculated,
      ),
    };
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

export const adminListingRecalculatePage = (
  listing: ListingWithCount,
  snapshot: ListingAggregateRecalculation,
  session: AdminSession,
  error?: string,
  success?: string,
): string =>
  listingRecalculateRenderer(listing, snapshot)(session, error, success);
