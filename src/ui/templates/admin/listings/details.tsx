import type { ListingAggregateRecalculation } from "#db/listings/aggregates.ts";
import { compact } from "#fp";
import { t } from "#i18n";
import type { Child } from "#jsx/jsx-runtime.ts";
import { formatCountdown } from "#routes/format.ts";
import { formatCurrency } from "#shared/currency.ts";
import { formatDatetimeLabel } from "#shared/dates.ts";
import {
  CopyableInputRow,
  type CopyableInputRowSpec,
} from "#templates/admin/copyable-row.tsx";
import type { DetailRow } from "#templates/admin/detail-rows.tsx";
import { HiddenDetailRow } from "#templates/admin/hidden-row.tsx";
import {
  availablePublicUrl,
  PublicUrlRows,
  type PublicUrlRowsProps,
} from "#templates/admin/public-url-rows.tsx";
import { DetailTable } from "#templates/components/detail-table.tsx";
import { LabelledRow } from "#templates/components/labelled-row.tsx";
import {
  availableDayCounts,
  clampDurationDays,
  dayPriceFor,
  type ListingWithCount,
} from "#types";
import { ListingAggregateMismatchRow } from "./aggregates.tsx";
import {
  ListingCapacityRows,
  type ListingCapacityRowsProps,
} from "./capacity-rows.tsx";
import { formatBookableDays } from "./helpers.ts";

/** Props for the detail rows that only need the listing they describe. */
type ListingRowProps = {
  listing: ListingWithCount;
};

const CustomisableDaysRow = ({ listing }: ListingRowProps): JSX.Element => {
  const counts = availableDayCounts(listing);
  return (
    <tr>
      <th>{t("listings_table.customisable_days")}</th>
      <td>
        {t("listings_table.visitors_choose_days", {
          max_days: clampDurationDays(listing.duration_days),
        })}{" "}
        {counts.length > 0 ? (
          <span>
            {counts
              .map(
                (n) =>
                  `${n} ${t(
                    `listings_table.day_count_unit_${
                      n === 1 ? "singular" : "plural"
                    }`,
                  )}: ${formatCurrency(dayPriceFor(listing, n)!)}`,
              )
              .join(", ")}
          </span>
        ) : (
          <em>{t("listings_table.no_day_prices_set")}</em>
        )}
      </td>
    </tr>
  );
};

const ListingPriceRow = ({ listing }: ListingRowProps): JSX.Element => {
  const price =
    listing.unit_price > 0
      ? formatCurrency(listing.unit_price)
      : t("listings_table.free");
  const payMoreSuffix = listing.can_pay_more
    ? listing.max_price > listing.unit_price
      ? ` (${t("listings_table.pay_more_range", {
          max: formatCurrency(listing.max_price),
          min: price,
        })})`
      : ` (${t("listings_table.pay_more_enabled")})`
    : "";
  return (
    <tr>
      <th>{t("listings_table.ticket_price")}</th>
      <td>
        {price}
        {payMoreSuffix}
      </td>
    </tr>
  );
};

const DailyScheduleRows = ({ listing }: ListingRowProps): JSX.Element => (
  <>
    <LabelledRow label={t("listings_table.bookable_days")}>
      {formatBookableDays(listing.bookable_days)}
    </LabelledRow>
    <LabelledRow label={t("listings_table.booking_window")}>
      {listing.minimum_days_before} {t("listings_table.to")}{" "}
      {listing.maximum_days_after === 0
        ? t("listings_table.unlimited")
        : listing.maximum_days_after}{" "}
      {t("listings_table.days_from_today")}
    </LabelledRow>
    <LabelledRow label={t("listings_table.booking_duration")}>
      {listing.duration_days} {t("listings_table.day_count_with_parens")}
    </LabelledRow>
  </>
);

/** A formatted instant followed by its countdown, as both the listing date
 * (linked to the calendar) and the registration deadline show it. */
const withCountdown = (label: Child, at: string): JSX.Element => (
  <>
    {label}{" "}
    <small>
      <em>({formatCountdown(at)})</em>
    </small>
  </>
);

const buildListingCopyRows = (
  listing: ListingWithCount,
): CopyableInputRowSpec[] =>
  compact([
    listing.thank_you_url
      ? {
          id: `thank-you-url-${listing.id}`,
          label: t("listings_table.thank_you_url"),
          value: listing.thank_you_url,
        }
      : null,
    listing.webhook_url
      ? {
          id: `webhook-url-${listing.id}`,
          label: t("listings_table.webhook_url"),
          value: listing.webhook_url,
        }
      : null,
  ]);

/** The Public URL rows for this listing: its live rows, or the note that says
 * why its public page does not serve. */
const publicUrlRowsProps = (
  listing: ListingWithCount,
  publicPage: "available" | "child" | "inactive",
  allowedDomain: string,
): PublicUrlRowsProps => {
  if (publicPage !== "available") {
    return {
      kind: "unavailable",
      message:
        publicPage === "child"
          ? t("listings_table.child_share_suppressed")
          : t("listings_table.inactive_share_suppressed"),
    };
  }
  return availablePublicUrl(listing.id, listing.slug, allowedDomain);
};

export const ListingDetailsTable = ({
  listing,
  aggregateRecalculation,
  allowedDomain,
  capacity,
  sharedRows,
  publicPage,
}: {
  listing: ListingWithCount;
  aggregateRecalculation?: ListingAggregateRecalculation | undefined;
  allowedDomain: string;
  capacity: ListingCapacityRowsProps;
  sharedRows: DetailRow[];
  publicPage: "available" | "child" | "inactive";
}): JSX.Element => {
  const copyRows = buildListingCopyRows(listing);
  return (
    <article>
      <DetailTable rows={sharedRows}>
        <tr>
          <th colspan="2">{listing.name}</th>
        </tr>
        {listing.date && (
          <tr>
            <th>{t("listings_table.listing_date")}</th>
            <td>
              <span>
                {withCountdown(
                  <a href={`/admin/calendar?date=${listing.date.slice(0, 10)}`}>
                    {formatDatetimeLabel(listing.date)}
                  </a>,
                  listing.date,
                )}
              </span>
            </td>
          </tr>
        )}
        {listing.location && (
          <tr>
            <th>{t("listings_table.location")}</th>
            <td>{listing.location}</td>
          </tr>
        )}
        <tr>
          <th>{t("listings_table.listing_type")}</th>
          <td>
            {listing.listing_type === "daily"
              ? t("listings_table.daily")
              : t("listings_table.standard")}
          </td>
        </tr>
        <ListingPriceRow listing={listing} />
        {listing.customisable_days && <CustomisableDaysRow listing={listing} />}
        {listing.months_per_unit > 0 && (
          <tr>
            <th>{t("listings_table.renewal")}</th>
            <td>
              {listing.months_per_unit} {t("listings_table.months_per_ticket")}
            </td>
          </tr>
        )}
        {listing.non_transferable && (
          <tr>
            <th>{t("listings_table.non_transferable")}</th>
            <td>{t("listings_table.yes_id_verification_required")}</td>
          </tr>
        )}
        {listing.hidden && <HiddenDetailRow />}
        {listing.listing_type === "daily" && (
          <DailyScheduleRows listing={listing} />
        )}
        <tr>
          <th>{t("listings_table.registration_closes")}</th>
          <td>
            {listing.closes_at ? (
              <span>
                {withCountdown(
                  formatDatetimeLabel(listing.closes_at),
                  listing.closes_at,
                )}
              </span>
            ) : (
              <em>{t("listings_table.no_deadline")}</em>
            )}
          </td>
        </tr>
        <PublicUrlRows
          {...publicUrlRowsProps(listing, publicPage, allowedDomain)}
        />
        {copyRows.map(CopyableInputRow)}
        <ListingCapacityRows {...capacity} />
        <ListingAggregateMismatchRow
          aggregateRecalculation={aggregateRecalculation}
          listing={listing}
        />
      </DetailTable>
    </article>
  );
};
