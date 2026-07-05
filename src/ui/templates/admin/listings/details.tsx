import { compact } from "#fp";
import { t } from "#i18n";
import { formatCountdown } from "#routes/format.ts";
import { formatCurrency } from "#shared/currency.ts";
import { formatDatetimeLabel } from "#shared/dates.ts";
import type { ListingAggregateRecalculation } from "#shared/db/listings.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import {
  availableDayCounts,
  dayPriceFor,
  type ListingWithCount,
  normalizeDurationDays,
} from "#shared/types.ts";
import {
  CopyableInputRow,
  type CopyableInputRowSpec,
} from "#templates/admin/copyable-row.tsx";
import {
  PublicTicketLink,
  UnavailablePublicUrlRow,
} from "#templates/admin/share-rows.tsx";
import { DetailTable } from "#templates/components/detail-table.tsx";
import { ListingAggregateMismatchRow } from "./aggregates.tsx";
import {
  ListingCapacityRows,
  type ListingCapacityRowsProps,
} from "./capacity-rows.tsx";
import { formatBookableDays } from "./helpers.ts";

const CustomisableDaysRow = ({
  listing,
}: {
  listing: ListingWithCount;
}): JSX.Element => {
  const counts = availableDayCounts(listing);
  return (
    <tr>
      <th>{t("listings_table.customisable_days")}</th>
      <td>
        {t("listings_table.visitors_choose_days", {
          max_days: normalizeDurationDays(listing.duration_days),
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

const ListingPriceRow = ({
  listing,
}: {
  listing: ListingWithCount;
}): JSX.Element => {
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

const DailyScheduleRows = ({
  listing,
}: {
  listing: ListingWithCount;
}): JSX.Element => (
  <>
    <tr>
      <th>{t("listings_table.bookable_days")}</th>
      <td>{formatBookableDays(listing.bookable_days)}</td>
    </tr>
    <tr>
      <th>{t("listings_table.booking_window")}</th>
      <td>
        {listing.minimum_days_before} {t("listings_table.to")}{" "}
        {listing.maximum_days_after === 0
          ? t("listings_table.unlimited")
          : listing.maximum_days_after}{" "}
        {t("listings_table.days_from_today")}
      </td>
    </tr>
    <tr>
      <th>{t("listings_table.booking_duration")}</th>
      <td>
        {listing.duration_days} {t("listings_table.day_count_with_parens")}
      </td>
    </tr>
  </>
);

const PublicUrlRow = ({
  listing,
  allowedDomain,
  ticketUrl,
  shareSuppressed,
  isChild,
}: {
  listing: ListingWithCount;
  allowedDomain: string;
  ticketUrl: string;
  shareSuppressed: boolean;
  isChild: boolean;
}): JSX.Element =>
  shareSuppressed ? (
    UnavailablePublicUrlRow({
      message: t(
        isChild
          ? "listings_table.child_share_suppressed"
          : "listings_table.package_member_share_suppressed",
      ),
    })
  ) : (
    <tr>
      <th>
        <label for={`embed-toggle-${listing.id}`}>
          {t("common.public_url")}
          <span class="embed-toggle-badge">embed</span>
        </label>
      </th>
      <td>
        <input
          class="visually-hidden listing-embed-toggle"
          id={`embed-toggle-${listing.id}`}
          type="checkbox"
        />
        <PublicTicketLink
          href={ticketUrl}
          label={`${allowedDomain}/ticket/${listing.slug}`}
          qrHref={`/ticket/${listing.slug}/qr`}
        />
      </td>
    </tr>
  );

export const ListingDetailsTable = ({
  listing,
  aggregateRecalculation,
  allowedDomain,
  ticketUrl,
  embedScriptCode,
  embedIframeCode,
  capacity,
  sharedRowsHtml,
  isChild,
  isHiddenPackageMember,
}: {
  listing: ListingWithCount;
  aggregateRecalculation?: ListingAggregateRecalculation | undefined;
  allowedDomain: string;
  ticketUrl: string;
  embedScriptCode: string;
  embedIframeCode: string;
  capacity: ListingCapacityRowsProps;
  sharedRowsHtml: string;
  isChild: boolean;
  isHiddenPackageMember: boolean;
}): JSX.Element => {
  const shareSuppressed = isChild || isHiddenPackageMember;
  const copyRows: CopyableInputRowSpec[] = compact([
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
    !shareSuppressed
      ? {
          className: "listing-embed-row",
          id: `embed-script-${listing.id}`,
          label: t("common.embed_script"),
          value: embedScriptCode,
        }
      : null,
    !shareSuppressed
      ? {
          className: "listing-embed-row",
          id: `embed-iframe-${listing.id}`,
          label: t("common.embed_iframe"),
          value: embedIframeCode,
        }
      : null,
  ]);
  return (
    <article>
      <DetailTable>
        <tr>
          <th colspan="2">{listing.name}</th>
        </tr>
        {listing.date && (
          <tr>
            <th>{t("listings_table.listing_date")}</th>
            <td>
              <span>
                <a href={`/admin/calendar?date=${listing.date.slice(0, 10)}`}>
                  {formatDatetimeLabel(listing.date)}
                </a>{" "}
                <small>
                  <em>({formatCountdown(listing.date)})</em>
                </small>
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
        {listing.hidden && (
          <tr>
            <th>{t("listings_table.hidden")}</th>
            <td>{t("listings_table.yes_not_shown_in_public_list")}</td>
          </tr>
        )}
        {listing.listing_type === "daily" && (
          <DailyScheduleRows listing={listing} />
        )}
        <tr>
          <th>{t("listings_table.registration_closes")}</th>
          <td>
            {listing.closes_at ? (
              <span>
                {formatDatetimeLabel(listing.closes_at)}{" "}
                <small>
                  <em>({formatCountdown(listing.closes_at)})</em>
                </small>
              </span>
            ) : (
              <em>{t("listings_table.no_deadline")}</em>
            )}
          </td>
        </tr>
        <PublicUrlRow
          allowedDomain={allowedDomain}
          isChild={isChild}
          listing={listing}
          shareSuppressed={shareSuppressed}
          ticketUrl={ticketUrl}
        />
        {copyRows.map(CopyableInputRow)}
        <ListingCapacityRows {...capacity} />
        <ListingAggregateMismatchRow
          aggregateRecalculation={aggregateRecalculation}
          listing={listing}
        />
        <Raw html={sharedRowsHtml} />
      </DetailTable>
    </article>
  );
};
