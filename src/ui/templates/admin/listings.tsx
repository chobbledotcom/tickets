/**
 * Admin listing page templates - detail, edit, delete
 */

import { filter, joinStrings, map, mapNotNullish, pipe } from "#fp";
import { t } from "#i18n";
import { isBuilderEnabled } from "#routes/admin/builder.ts";
import { formatCountdown } from "#routes/format.ts";
import { targetQuery } from "#shared/bulk-email.ts";
import { formatCurrency, toMajorUnits } from "#shared/currency.ts";
import {
  formatDateLabel,
  formatDatetimeLabel,
  formatDatetimeShort,
} from "#shared/dates.ts";
import type {
  ListingAggregateField,
  ListingAggregateRecalculation,
  ListingRevenueBreakdown,
} from "#shared/db/listings.ts";
import { settings } from "#shared/db/settings.ts";
import { buildEmbedSnippets } from "#shared/embed.ts";
import { isReadOnly } from "#shared/env.ts";
import type { Field } from "#shared/forms.tsx";
import {
  booleanToCheckbox,
  ConfirmForm,
  CsrfForm,
  entityToFieldValues,
  type FieldValues,
  Flash,
  renderFields,
} from "#shared/forms.tsx";
import { escapeHtml, Raw } from "#shared/jsx/jsx-runtime.ts";
import { isStorageEnabled } from "#shared/storage.ts";
import { utcToLocalInput } from "#shared/timezone.ts";
import {
  type AdminSession,
  type Attendee,
  availableDayCounts,
  dayPriceFor,
  type Group,
  isPaidListing,
  type ListingWithCount,
  normalizeDurationDays,
} from "#shared/types.ts";
import { buildSharedDetailRows } from "#templates/admin/detail-rows.tsx";
import {
  type ExpectedActualItem,
  ExpectedActualNotice,
  hasExpectedActualMismatches,
} from "#templates/admin/expected-actual.tsx";
import { ListingGroupSelect } from "#templates/admin/group-select.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";
import {
  adminRecalculatePage,
  type RecalculateRow,
} from "#templates/admin/recalculate.tsx";
import {
  AttendeeTable,
  type AttendeeTableRow,
  type TableQuestionData,
} from "#templates/attendee-table.tsx";
import {
  MaybeButtonLink,
  SubmitButton,
} from "#templates/components/actions.tsx";
import {
  getAddAttendeeFields,
  getAssignBuiltSiteField,
  getAttachmentField,
  getImageField,
  getInitialSiteMonthsField,
  getListingFields,
  getMonthsPerUnitField,
  getSlugField,
  listingAggregateFields,
  logisticsField,
} from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";
import { renderListingImage } from "#templates/public.tsx";

/** Date option for the date filter dropdown */
export type DateOption = { value: string; label: string };

/** Attendee filter type */
export type AttendeeFilter = "all" | "in" | "out";

/** Re-export shared detail functions for template composition */
export {
  calculateTotalRevenue,
  countCheckedIn,
  countCheckedInRows,
  sumQuantity,
} from "#templates/admin/detail-rows.tsx";
/** Re-export formatAddressInline from shared module for template composition */
export { formatAddressInline } from "#templates/attendee-table.tsx";

import {
  buildAnswerSummaryRows as buildAnswerSummaryDetailRows,
  renderDetailRows,
  sumQuantity,
} from "#templates/admin/detail-rows.tsx";

/** Build answer count summary rows as an HTML string of <tr> elements */
export const buildAnswerSummaryRows = (
  questionData: TableQuestionData | undefined,
): string => renderDetailRows(buildAnswerSummaryDetailRows(questionData));

/** Check if listing is within 10% of capacity */
export const nearCapacity = (listing: ListingWithCount): boolean =>
  listing.attendee_count >= listing.max_attendees * 0.9;

/** The remaining override-managed aggregates are integer counts, so each is
 * rendered with `String`. (Income is no longer an aggregate column — it's
 * projected from the ledger — so it has no formatter here.) */
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
  aggregateRecalculation?: ListingAggregateRecalculation,
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

const ListingAggregateMismatchNotice = ({
  aggregateRecalculation,
  actionHref,
}: {
  aggregateRecalculation?: ListingAggregateRecalculation;
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

const ListingAggregateMismatchRow = ({
  aggregateRecalculation,
  listing,
}: {
  aggregateRecalculation?: ListingAggregateRecalculation;
  listing: ListingWithCount;
}): JSX.Element | null => {
  const items = listingAggregateMismatchItems(aggregateRecalculation);
  if (!hasExpectedActualMismatches(items)) return null;
  return (
    <tr>
      <th>{t("listings_table.running_total_check")}</th>
      <td>
        <ExpectedActualNotice
          actionHref={`/admin/listings/recalculate/${listing.id}`}
          actionLabel={t("listings_table.running_totals_error_action")}
          explanation={t("listings_table.running_totals_error_explanation")}
          items={items}
          title={t("listings_table.running_totals_error_title")}
        />
      </td>
    </tr>
  );
};

/**
 * Check if an attendee has an incomplete/failed payment.
 * True when the listing is paid, the attendee has no payment reference,
 * but was charged a non-zero price (distinguishing from admin-added attendees
 * who have price_paid=0).
 */
export const isIncompletePayment = (
  attendee: Attendee,
  hasPaidListing: boolean,
): boolean =>
  hasPaidListing &&
  !attendee.payment_id &&
  Number.parseInt(attendee.price_paid, 10) > 0;

/** Render a single row in the Failed Payments table */
const FailedPaymentRow = ({
  attendee,
  listingId,
}: {
  attendee: Attendee;
  listingId: number;
}): string =>
  String(
    <tr>
      <td>{attendee.name}</td>
      <td>{attendee.quantity}</td>
      <td>{formatDatetimeShort(attendee.created)}</td>
      <td>
        <CsrfForm
          action={`/admin/listing/${listingId}/attendee/${attendee.id}/delete-incomplete`}
          class="inline"
        >
          <button class="link-button danger" type="submit">
            {t("common.delete")}
          </button>
        </CsrfForm>
      </td>
    </tr>,
  );

/** Render a table of attendees with failed/incomplete payments */
const FailedPaymentsTable = ({
  attendees,
  listingId,
}: {
  attendees: Attendee[];
  listingId: number;
}): string =>
  String(
    <table>
      <thead>
        <tr>
          <th>{t("common.name")}</th>
          <th>{t("common.qty")}</th>
          <th>{t("common.registered")}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <Raw
          html={pipe(
            map((a: Attendee) => FailedPaymentRow({ attendee: a, listingId })),
            joinStrings,
          )(attendees)}
        />
      </tbody>
    </table>,
  );

/** Check-in message to display after toggling */
export type CheckinMessage = { name: string; status: string } | null;

/** Filter attendees by check-in status */
export const filterAttendees = (
  attendees: Attendee[],
  activeFilter: AttendeeFilter,
): Attendee[] => {
  if (activeFilter === "in") {
    return filter((a: Attendee) => a.checked_in)(attendees);
  }
  if (activeFilter === "out") {
    return filter((a: Attendee) => !a.checked_in)(attendees);
  }
  return attendees;
};

/** Render a filter link, bold if active */
const FilterLink = ({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}): string =>
  active
    ? String(<strong>{label}</strong>)
    : String(<a href={href}>{label}</a>);

/** Build the path suffix for a checkin filter (preserves date query) */
const filterSuffix = (activeFilter: AttendeeFilter): string =>
  activeFilter === "all" ? "" : `/${activeFilter}`;

/** Date selector dropdown for daily listings */
const DateSelector = ({
  basePath,
  activeFilter,
  dateFilter,
  dates,
}: {
  basePath: string;
  activeFilter: AttendeeFilter;
  dateFilter: string | null;
  dates: DateOption[];
}): string => {
  const suffix = filterSuffix(activeFilter);
  const options = [
    `<option value="${basePath}${suffix}#attendees"${
      !dateFilter ? " selected" : ""
    }>${t("listings_table.all_dates")}</option>`,
    ...dates.map(
      (d) =>
        `<option value="${basePath}${suffix}?date=${d.value}#attendees"${
          dateFilter === d.value ? " selected" : ""
        }>${d.label}</option>`,
    ),
  ].join("");
  return `<select data-nav-select aria-label="${t(
    "listings_table.filter_by_date",
  )}">${options}</select>`;
};

// ---------------------------------------------------------------------------
// Income & ledger breakdown
//
// A listing's income now projects from the `transfers` ledger, where two
// correct-but-different figures exist for the same `revenue:<id>` account:
// the RECOGNISED INCOME (refund-agnostic, the reported figure) and the NET
// LEDGER BALANCE (which a refund also reduces). After a refund they legitimately
// differ, so this section renders both from the same running totals — gross
// sales (+) and manual adjustments (±) make up recognised income, and refunds
// (−) take it down to the net balance — making the difference self-evident.
// ---------------------------------------------------------------------------

/** Render a magnitude with an explicit leading sign, so a credit and a debit of
 * the same size never read alike (mirrors the ledger statement's signed delta).
 * A zero shows as a plain, unsigned `£0`. */
const signedCurrency = (value: number): string =>
  value === 0
    ? formatCurrency(0)
    : `${value < 0 ? "−" : "+"}${formatCurrency(Math.abs(value))}`;

/** One row of the breakdown table: a label and a right-aligned figure, with an
 * optional `subtotal` modifier that bolds the two reconciled lines (recognised
 * income, net balance). */
const BreakdownRow = ({
  label,
  amount,
  subtotal = false,
}: {
  label: string;
  amount: string;
  subtotal?: boolean;
}): JSX.Element => (
  <tr class={subtotal ? "breakdown-subtotal" : undefined}>
    <th>{subtotal ? <strong>{label}</strong> : label}</th>
    <td class="breakdown-amount">
      {subtotal ? <strong>{amount}</strong> : amount}
    </td>
  </tr>
);

/**
 * The "Income & ledger" reconciliation table for one listing's revenue account.
 * Renders gross sales (+), manual adjustments (± — omitted only when there have
 * never been any, so the recognised-income subtotal still adds up on its face),
 * the recognised-income subtotal (bold), refunds (−), and the net-balance
 * subtotal (bold). Render-only: the feature layer supplies the projected
 * {@link ListingRevenueBreakdown}; a plain-English line plus a link to the full
 * per-account ledger statement explain why the two subtotals can differ.
 */
const ListingIncomeLedgerSection = ({
  breakdown,
  listingId,
}: {
  breakdown: ListingRevenueBreakdown;
  listingId: number;
}): JSX.Element => (
  <article id="income-ledger">
    <fieldset class="listing-section">
      <legend>{t("listings_table.income_ledger_legend")}</legend>
      <div class="table-scroll">
        <table class="listing-breakdown-table">
          <tbody>
            <BreakdownRow
              amount={signedCurrency(breakdown.grossSales)}
              label={t("listings_table.income_ledger_gross_sales")}
            />
            {breakdown.manualAdjustments !== 0 && (
              <BreakdownRow
                amount={signedCurrency(breakdown.manualAdjustments)}
                label={t("listings_table.income_ledger_manual_adjustments")}
              />
            )}
            <BreakdownRow
              amount={formatCurrency(breakdown.recognisedIncome)}
              label={t("listings_table.income_ledger_recognised_income")}
              subtotal
            />
            <BreakdownRow
              amount={signedCurrency(-breakdown.refunds)}
              label={t("listings_table.income_ledger_refunds")}
            />
            <BreakdownRow
              amount={formatCurrency(breakdown.netBalance)}
              label={t("listings_table.income_ledger_net_balance")}
              subtotal
            />
          </tbody>
        </table>
      </div>
      <p>
        <small>{t("listings_table.income_ledger_recognised_note")}</small>
      </p>
      <p class="actions">
        <a href={`/admin/ledger/revenue/${listingId}`}>
          {t("listings_table.income_ledger_view_full")}
        </a>
      </p>
    </fieldset>
  </article>
);

/** Options for rendering the admin listing detail page */
/** Group + current attendee count, supplied when the listing is in a capped
 * group so the detail page can show group-wide capacity beneath the
 * listing's own. Only the cap > 0 case needs surfacing. */
export type GroupContext = {
  group: Group;
  attendeeCount: number;
};

export type AdminListingPageOptions = {
  listing: ListingWithCount;
  attendees: Attendee[];
  allowedDomain: string;
  session: AdminSession;
  aggregateRecalculation?: ListingAggregateRecalculation;
  checkinMessage?: CheckinMessage;
  activeFilter?: AttendeeFilter;
  dateFilter?: string | null;
  availableDates?: DateOption[];
  errorMessage?: string;
  phonePrefix?: string;
  successMessage?: string;
  questionData?: TableQuestionData;
  groupContext?: GroupContext;
  /** The listing's revenue-account breakdown (gross sales, manual adjustments,
   * recognised income, refunds, net balance), reconciling the reported income
   * with the live ledger balance. Omitted only by template callers that don't
   * exercise the section. */
  revenueBreakdown?: ListingRevenueBreakdown;
  /** Whether any of the listing's attendees (across all dates) have an email
   * address — gates the owner-only "Email" action. */
  hasEmailableAttendees?: boolean;
};

/** Top action nav for the listing detail page */
const ListingActionNav = ({
  listing,
  hasPaidListing,
  isOwner,
  hasEmailableAttendees,
}: {
  listing: ListingWithCount;
  hasPaidListing: boolean;
  isOwner: boolean;
  hasEmailableAttendees: boolean;
}): JSX.Element => {
  const readOnly = isReadOnly();
  return (
    <nav>
      <ul>
        {!readOnly && (
          <li>
            <a href={`/admin/listing/${listing.id}/edit`}>{t("common.edit")}</a>
          </li>
        )}
        {!readOnly && (
          <li>
            <a href={`/admin/listing/${listing.id}/duplicate`}>
              {t("listings_table.duplicate")}
            </a>
          </li>
        )}
        <li>
          <a href={`/admin/listing/${listing.id}/log`}>
            {t("listings_table.log")}
          </a>
        </li>
        {!listing.purchase_only && (
          <li>
            <a href={`/admin/listing/${listing.id}/scanner`}>
              {t("listings_table.scanner")}
            </a>
          </li>
        )}
        <li>
          <a href={`/admin/listing/${listing.id}/questions`}>
            {t("terms.questions")}
          </a>
        </li>
        {!readOnly && (
          <li>
            <a href={`/admin/listing/${listing.id}/qr`}>
              {t("listings_table.booking_qr")}
            </a>
          </li>
        )}
        {isOwner && (
          <li>
            <MaybeButtonLink
              disabled={!hasEmailableAttendees}
              href={`/admin/emails${targetQuery({
                kind: "listing",
                listingId: listing.id,
              })}`}
              title={
                hasEmailableAttendees
                  ? undefined
                  : t("listings_table.no_email_attendees")
              }
            >
              {t("common.email")}
            </MaybeButtonLink>
          </li>
        )}
        {hasPaidListing && (
          <li>
            <a class="danger" href={`/admin/listing/${listing.id}/refund-all`}>
              {t("listings_table.refund_all")}
            </a>
          </li>
        )}
        {listing.active ? (
          <li>
            <a class="danger" href={`/admin/listing/${listing.id}/deactivate`}>
              {t("listings_table.deactivate")}
            </a>
          </li>
        ) : (
          <li>
            <a href={`/admin/listing/${listing.id}/reactivate`}>
              {t("listings_table.reactivate")}
            </a>
          </li>
        )}
        <li>
          <a class="danger" href={`/admin/listing/${listing.id}/delete`}>
            {t("common.delete")}
          </a>
        </li>
      </ul>
    </nav>
  );
};

/** Detail row listing each offered day count and its price, shown when a
 * listing has customisable days so owners can verify pricing at a glance. */
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

/** Compact price row for the listing details table. Keeps the high-signal
 * booking price visible without adding another crowded admin-only metric. */
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

/** Daily-specific schedule rows (bookable days, booking window) */
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

/** Attendee count cell content (varies by daily/date-filter state) */
const AttendeeCountDisplay = ({
  listing,
  isDaily,
  dateFilter,
  adjustedCount,
  completeQuantitySum,
}: {
  listing: ListingWithCount;
  isDaily: boolean;
  dateFilter: string | null;
  adjustedCount: number;
  completeQuantitySum: number;
}): JSX.Element => {
  if (isDaily && dateFilter) {
    const overCap = completeQuantitySum >= listing.max_attendees;
    return (
      <span class={overCap ? "danger-text" : ""}>
        {completeQuantitySum} / {listing.max_attendees} —{" "}
        {listing.max_attendees - completeQuantitySum}{" "}
        {t("listings_table.remain")}
      </span>
    );
  }
  const nearCap = adjustedCount >= listing.max_attendees * 0.9;
  return (
    <span class={nearCap ? "danger-text" : ""}>
      {adjustedCount}
      {!isDaily && (
        <>
          {" "}
          / {listing.max_attendees} — {listing.max_attendees - adjustedCount}{" "}
          {t("listings_table.remain")}
        </>
      )}
    </span>
  );
};

/** Attendees row (header + count summary + daily capacity note) */
const AttendeesSummaryRow = ({
  listing,
  isDaily,
  dateFilter,
  dailySuffix,
  adjustedCount,
  completeQuantitySum,
}: {
  listing: ListingWithCount;
  isDaily: boolean;
  dateFilter: string | null;
  dailySuffix: string;
  adjustedCount: number;
  completeQuantitySum: number;
}): JSX.Element => (
  <tr>
    <th>
      {t("listings_table.listing_attendees")}
      {dailySuffix}
    </th>
    <td>
      <AttendeeCountDisplay
        adjustedCount={adjustedCount}
        completeQuantitySum={completeQuantitySum}
        dateFilter={dateFilter}
        isDaily={isDaily}
        listing={listing}
      />
      {isDaily && !dateFilter && (
        <>
          {" "}
          <small>
            {t("listings_table.capacity_per_date", {
              capacity: listing.max_attendees,
            })}
          </small>
        </>
      )}
    </td>
  </tr>
);

/** Group capacity row shown below the listing-attendees row when the listing
 * belongs to a capped group. The label makes the group source explicit so
 * admins see why a not-yet-full listing might still be sold out. */
const GroupAttendeesRow = ({
  group,
  groupAttendeeCount,
  dailySuffix,
}: {
  group: Group;
  groupAttendeeCount: number;
  dailySuffix: string;
}): JSX.Element => {
  const remaining = Math.max(0, group.max_attendees - groupAttendeeCount);
  const overCap = groupAttendeeCount >= group.max_attendees;
  const nearCap = groupAttendeeCount >= group.max_attendees * 0.9;
  return (
    <tr>
      <th>
        {t("listings_table.group_attendees")}
        {dailySuffix}
      </th>
      <td>
        <span class={overCap || nearCap ? "danger-text" : ""}>
          {groupAttendeeCount} / {group.max_attendees} — {remaining}{" "}
          {t("listings_table.remain")}
        </span>{" "}
        <small>
          {t("listings_table.across_all_listings_in")}{" "}
          <a href={`/admin/groups/${group.id}`}>{group.name}</a>
        </small>
      </td>
    </tr>
  );
};

/** Listing details table - all listing metadata rows */
const ListingDetailsTable = ({
  listing,
  aggregateRecalculation,
  allowedDomain,
  ticketUrl,
  embedScriptCode,
  embedIframeCode,
  isDaily,
  dateFilter,
  dailySuffix,
  adjustedCount,
  completeQuantitySum,
  groupContext,
  sharedRowsHtml,
}: {
  listing: ListingWithCount;
  aggregateRecalculation?: ListingAggregateRecalculation;
  allowedDomain: string;
  ticketUrl: string;
  embedScriptCode: string;
  embedIframeCode: string;
  isDaily: boolean;
  dateFilter: string | null;
  dailySuffix: string;
  adjustedCount: number;
  completeQuantitySum: number;
  groupContext: GroupContext | undefined;
  sharedRowsHtml: string;
}): JSX.Element => (
  <article>
    <div class="table-scroll">
      <table class="listing-details-table">
        <tbody>
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
          {listing.customisable_days && (
            <CustomisableDaysRow listing={listing} />
          )}
          {listing.months_per_unit > 0 && (
            <tr>
              <th>{t("listings_table.renewal")}</th>
              <td>
                {listing.months_per_unit}{" "}
                {t("listings_table.months_per_ticket")}
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
              <a href={ticketUrl}>
                {`${allowedDomain}/ticket/${listing.slug}`}
              </a>
              <small>
                {" "}
                (
                <a href={`/ticket/${listing.slug}/qr`}>{t("common.qr_code")}</a>
                )
              </small>
            </td>
          </tr>
          {listing.thank_you_url && (
            <tr>
              <th>
                <label for={`thank-you-url-${listing.id}`}>
                  {t("listings_table.thank_you_url")}
                </label>
              </th>
              <td>
                <input
                  data-select-on-click
                  id={`thank-you-url-${listing.id}`}
                  readonly
                  type="text"
                  value={listing.thank_you_url}
                />
              </td>
            </tr>
          )}
          {listing.webhook_url && (
            <tr>
              <th>
                <label for={`webhook-url-${listing.id}`}>
                  {t("listings_table.webhook_url")}
                </label>
              </th>
              <td>
                <input
                  data-select-on-click
                  id={`webhook-url-${listing.id}`}
                  readonly
                  type="text"
                  value={listing.webhook_url}
                />
              </td>
            </tr>
          )}
          <tr class="listing-embed-row">
            <th>
              <label for={`embed-script-${listing.id}`}>
                {t("common.embed_script")}
              </label>
            </th>
            <td>
              <input
                data-select-on-click
                id={`embed-script-${listing.id}`}
                readonly
                type="text"
                value={embedScriptCode}
              />
            </td>
          </tr>
          <tr class="listing-embed-row">
            <th>
              <label for={`embed-iframe-${listing.id}`}>
                {t("common.embed_iframe")}
              </label>
            </th>
            <td>
              <input
                data-select-on-click
                id={`embed-iframe-${listing.id}`}
                readonly
                type="text"
                value={embedIframeCode}
              />
            </td>
          </tr>
          <AttendeesSummaryRow
            adjustedCount={adjustedCount}
            completeQuantitySum={completeQuantitySum}
            dailySuffix={dailySuffix}
            dateFilter={dateFilter}
            isDaily={isDaily}
            listing={listing}
          />
          {groupContext && (
            <GroupAttendeesRow
              dailySuffix={dailySuffix}
              group={groupContext.group}
              groupAttendeeCount={groupContext.attendeeCount}
            />
          )}
          <ListingAggregateMismatchRow
            aggregateRecalculation={aggregateRecalculation}
            listing={listing}
          />
          <Raw html={sharedRowsHtml} />
        </tbody>
      </table>
    </div>
  </article>
);

/** Attendees filter links (All / Checked In / Checked Out) */
const AttendeesFilterLinks = ({
  basePath,
  dateQs,
  activeFilter,
}: {
  basePath: string;
  dateQs: string;
  activeFilter: AttendeeFilter;
}): JSX.Element => (
  <p>
    <Raw
      html={FilterLink({
        active: activeFilter === "all",
        href: `${basePath}${dateQs}#attendees`,
        label: t("listings_table.all"),
      })}
    />
    {" / "}
    <Raw
      html={FilterLink({
        active: activeFilter === "in",
        href: `${basePath}/in${dateQs}#attendees`,
        label: t("common.checked_in"),
      })}
    />
    {" / "}
    <Raw
      html={FilterLink({
        active: activeFilter === "out",
        href: `${basePath}/out${dateQs}#attendees`,
        label: t("listings_table.checked_out"),
      })}
    />
  </p>
);

/** Attendees article section (header, optional check-in flash, filters, table) */
const AttendeesSection = ({
  allowedDomain,
  checkinMessage,
  isDaily,
  availableDates,
  activeFilter,
  dateFilter,
  basePath,
  dateQs,
  returnUrl,
  tableRows,
  questionData,
  phonePrefix,
}: {
  allowedDomain: string;
  checkinMessage: CheckinMessage | undefined;
  isDaily: boolean;
  availableDates: DateOption[];
  activeFilter: AttendeeFilter;
  dateFilter: string | null;
  basePath: string;
  dateQs: string;
  returnUrl: string;
  tableRows: AttendeeTableRow[];
  questionData: TableQuestionData | undefined;
  phonePrefix: string | undefined;
}): JSX.Element => {
  const checkedInLabel =
    checkinMessage?.status === "in"
      ? t("listings_table.in")
      : t("listings_table.out");
  const checkedInClass =
    checkinMessage?.status === "in"
      ? "checkin-message-in"
      : "checkin-message-out";
  // The export mirrors the current view: the date filter plus the active
  // check-in filter (/in or /out), so the CSV matches the rows on screen.
  const exportParams = new URLSearchParams();
  if (dateFilter) exportParams.set("date", dateFilter);
  if (activeFilter !== "all") exportParams.set("checkin", activeFilter);
  const exportQuery = exportParams.toString();
  const exportHref = `${basePath}/export${
    exportQuery ? `?${exportQuery}` : ""
  }`;
  return (
    <article>
      <div class="prose">
        <h2 id="attendees">{t("terms.attendees")}</h2>
        {checkinMessage && (
          <p class={checkedInClass} id="message">
            {t("listings_table.checked", {
              name: checkinMessage.name,
              status: checkedInLabel,
            })}
          </p>
        )}
      </div>
      {isDaily && availableDates.length > 0 && (
        <Raw
          html={DateSelector({
            activeFilter,
            basePath,
            dateFilter,
            dates: availableDates,
          })}
        />
      )}
      <AttendeesFilterLinks
        activeFilter={activeFilter}
        basePath={basePath}
        dateQs={dateQs}
      />
      <div class="table-scroll">
        <Raw
          html={AttendeeTable({
            activeFilter,
            allowedDomain,
            phonePrefix,
            questionData,
            returnUrl,
            rows: tableRows,
            showDate: isDaily,
            showListing: false,
          })}
        />
      </div>
      <p class="table-footer-actions">
        <a href={exportHref}>{t("listings_table.export_csv")}</a>
      </p>
    </article>
  );
};

/** Failed payments article (only rendered when there are incomplete attendees) */
const FailedPaymentsSection = ({
  attendees,
  listingId,
}: {
  attendees: Attendee[];
  listingId: number;
}): JSX.Element => (
  <article>
    <div class="prose">
      <h2 id="failed-payments">{t("listings_table.failed_payments")}</h2>
      <p>
        {t("listings_table.attendees_with_unresolved_payments", {
          count: attendees.length,
        })}
      </p>
    </div>
    <div class="table-scroll">
      <Raw html={FailedPaymentsTable({ attendees, listingId })} />
    </div>
  </article>
);

/** Add attendee form article (only rendered in writable mode) */
const AddAttendeeSection = ({
  listing,
}: {
  listing: ListingWithCount;
}): JSX.Element => (
  <article>
    <h2 id="add-attendee">{t("listings_table.add_attendee")}</h2>
    <CsrfForm action={`/admin/listing/${listing.id}/attendee`}>
      <Raw
        html={renderFields(
          getAddAttendeeFields(
            listing.fields,
            listing.listing_type === "daily",
            listing.customisable_days && listing.listing_type === "daily"
              ? availableDayCounts(listing)
              : undefined,
          ),
        )}
      />
      <SubmitButton icon="plus">
        {t("listings_table.add_attendee")}
      </SubmitButton>
    </CsrfForm>
  </article>
);

/**
 * The attendees shown in the main detail table: on a paid listing the rows
 * with unresolved payments are split out into the Failed Payments section, so
 * they are excluded here. The CSV export reuses this so the download matches
 * the rows on screen.
 */
export const completePaymentAttendees = (
  listing: ListingWithCount,
  attendees: Attendee[],
): Attendee[] =>
  isPaidListing(listing)
    ? filter((a: Attendee) => !isIncompletePayment(a, true))(attendees)
    : attendees;

/** Compute derived attendee stats needed by the detail page */
const computeAttendeeStats = (
  listing: ListingWithCount,
  attendees: Attendee[],
  hasPaidListing: boolean,
): {
  incompleteAttendees: Attendee[];
  completeAttendees: Attendee[];
  adjustedCount: number;
  completeQuantitySum: number;
} => {
  const incompleteAttendees = hasPaidListing
    ? filter((a: Attendee) => isIncompletePayment(a, true))(attendees)
    : [];
  const completeAttendees = completePaymentAttendees(listing, attendees);
  const adjustedCount =
    listing.attendee_count - sumQuantity(incompleteAttendees);
  const completeQuantitySum = sumQuantity(completeAttendees);
  return {
    adjustedCount,
    completeAttendees,
    completeQuantitySum,
    incompleteAttendees,
  };
};

export const adminListingPage = ({
  listing,
  attendees,
  allowedDomain,
  session,
  aggregateRecalculation,
  checkinMessage,
  activeFilter = "all",
  dateFilter = null,
  availableDates = [],
  errorMessage,
  phonePrefix,
  successMessage,
  questionData,
  groupContext,
  revenueBreakdown,
  hasEmailableAttendees = false,
}: AdminListingPageOptions): string => {
  const ticketUrl = `https://${allowedDomain}/ticket/${listing.slug}`;
  const { script: embedScriptCode, iframe: embedIframeCode } =
    buildEmbedSnippets(ticketUrl);
  const isDaily = listing.listing_type === "daily";
  const hasPaidListing = isPaidListing(listing);

  const {
    incompleteAttendees,
    completeAttendees,
    adjustedCount,
    completeQuantitySum,
  } = computeAttendeeStats(listing, attendees, hasPaidListing);

  const filteredAttendees = filterAttendees(completeAttendees, activeFilter);
  const dailySuffix = isDaily
    ? dateFilter
      ? ` (${formatDateLabel(dateFilter)})`
      : " (total)"
    : "";
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
  const dateQs = dateFilter ? `?date=${dateFilter}` : "";
  const suffix = filterSuffix(activeFilter);
  const returnUrl = `${basePath}${suffix}${dateQs}#attendees`;
  const tableRows: AttendeeTableRow[] = pipe(
    map(
      (a: Attendee): AttendeeTableRow => ({
        attendee: a,
        listingId: listing.id,
        listingName: listing.name,
      }),
    ),
  )(filteredAttendees);

  return String(
    <Layout title={t("listings_table.detail_title", { name: listing.name })}>
      <AdminNav active="/admin/" session={session} />
      <ListingActionNav
        hasEmailableAttendees={hasEmailableAttendees}
        hasPaidListing={hasPaidListing}
        isOwner={session.adminLevel === "owner"}
        listing={listing}
      />
      <Flash success={successMessage} />
      {!listing.active && (
        <div class="error" role="alert">
          {t("listings_table.listing_deactivated_warning")}
        </div>
      )}
      <Flash error={errorMessage} />
      <ListingDetailsTable
        adjustedCount={adjustedCount}
        aggregateRecalculation={aggregateRecalculation}
        allowedDomain={allowedDomain}
        completeQuantitySum={completeQuantitySum}
        dailySuffix={dailySuffix}
        dateFilter={dateFilter}
        embedIframeCode={embedIframeCode}
        embedScriptCode={embedScriptCode}
        groupContext={groupContext}
        isDaily={isDaily}
        listing={listing}
        sharedRowsHtml={renderDetailRows(sharedRows)}
        ticketUrl={ticketUrl}
      />
      {revenueBreakdown && (
        <ListingIncomeLedgerSection
          breakdown={revenueBreakdown}
          listingId={listing.id}
        />
      )}
      <AttendeesSection
        activeFilter={activeFilter}
        allowedDomain={allowedDomain}
        availableDates={availableDates}
        basePath={basePath}
        checkinMessage={checkinMessage}
        dateFilter={dateFilter}
        dateQs={dateQs}
        isDaily={isDaily}
        phonePrefix={phonePrefix}
        questionData={questionData}
        returnUrl={returnUrl}
        tableRows={tableRows}
      />
      {incompleteAttendees.length > 0 && (
        <FailedPaymentsSection
          attendees={incompleteAttendees}
          listingId={listing.id}
        />
      )}
      {!isReadOnly() && <AddAttendeeSection listing={listing} />}
    </Layout>,
  );
};

/** Format an ISO datetime string for datetime-local input (YYYY-MM-DDTHH:MM) */
const formatDatetimeLocal = (iso: string | null): string | null => {
  if (!iso) return null;
  return utcToLocalInput(iso, settings.timezone);
};

const formatBookableDays = (days: string[]): string => days.join(", ");

/**
 * Render the per-day-count price inputs for "customisable days" listings: one
 * text input per day from 1 to the listing's maximum booking duration,
 * pre-filled from the stored `day_prices`. Rendered on every listing form but
 * only meaningful when "Customisable Days" is enabled (the client script and
 * server validation both gate on that checkbox). New listings start with a
 * single row; increasing the maximum and saving reveals more rows.
 */
export const renderDayPricesFieldset = (listing?: ListingWithCount): string => {
  const max = listing ? normalizeDurationDays(listing.duration_days) : 1;
  const prices = listing?.day_prices ?? {};
  const rows = Array.from({ length: max }, (_, i) => i + 1)
    .map((n) => {
      const stored = prices[n];
      const value = stored !== undefined ? toMajorUnits(stored) : "";
      return (
        `<label>${t("listings_table.day_price_row_label", { n })}` +
        `<input type="text" inputmode="decimal" name="day_price_${n}" ` +
        `value="${escapeHtml(value)}" pattern="\\d+(\\.\\d{1,2})?" ` +
        `placeholder="${t("listings_table.day_price_placeholder")}" title="${t(
          "listings_table.day_price_input_title",
        )}" />` +
        "</label>"
      );
    })
    .join("");
  return (
    `<fieldset data-day-prices id="day-prices">` +
    `<legend>${t("listings_table.day_prices_legend")}</legend>` +
    `<p><small>${t("listings_table.day_prices_help")}</small></p>` +
    rows +
    "</fieldset>"
  );
};

const listingFieldFormatters: Partial<
  Record<keyof ListingWithCount, (e: ListingWithCount) => string | null>
> = {
  assign_built_site: (e) => booleanToCheckbox(e.assign_built_site),
  bookable_days: (e) => formatBookableDays(e.bookable_days),
  can_pay_more: (e) => booleanToCheckbox(e.can_pay_more),
  closes_at: (e) => formatDatetimeLocal(e.closes_at),
  customisable_days: (e) => booleanToCheckbox(e.customisable_days),
  date: (e) => (e.date ? formatDatetimeLocal(e.date) : null),
  hidden: (e) => booleanToCheckbox(e.hidden),
  initial_site_months: (e) =>
    e.initial_site_months ? String(e.initial_site_months) : "",
  max_price: (e) => toMajorUnits(e.max_price),
  months_per_unit: (e) => (e.months_per_unit ? String(e.months_per_unit) : ""),
  non_transferable: (e) => booleanToCheckbox(e.non_transferable),
  purchase_only: (e) => booleanToCheckbox(e.purchase_only),
  unit_price: (e) => (e.unit_price > 0 ? toMajorUnits(e.unit_price) : ""),
  uses_logistics: (e) => booleanToCheckbox(e.uses_logistics),
};

const getAllListingFields = (): Field[] => [
  ...getListingFields(),
  logisticsField,
  getMonthsPerUnitField(),
  getInitialSiteMonthsField(),
  getAssignBuiltSiteField(),
];

const listingToFieldValues = (listing: ListingWithCount): FieldValues =>
  entityToFieldValues(listing, getAllListingFields(), listingFieldFormatters, {
    slug: listing.slug,
  });

export const listingAggregateToFieldValues = (
  listing: ListingWithCount,
): FieldValues => ({
  booked_quantity: listing.attendee_count,
  tickets_count: listing.tickets_count,
});

/**
 * Money-correction section, kept separate from the counts override ("splits by
 * kind", decision 14). Shows the current projected income (read-only) and an
 * input for the corrected value; submitting posts a `writeoff` adjustment for the
 * difference to the source-of-truth money ledger. A prominent warning states the
 * entry is appended, not destructive. Its own CsrfForm, so it posts independently
 * of the main edit form.
 */
const ListingIncomeAdjustSection = ({
  listing,
}: {
  listing: ListingWithCount;
}): JSX.Element => (
  <CsrfForm
    action={`/admin/listing/${listing.id}/income`}
    class="listing-section"
  >
    <h2>{t("listings_table.adjust_income")}</h2>
    <div class="error" role="alert">
      {t("listings_table.adjust_income_warning")}
    </div>
    <label>
      {t("listings_table.adjust_income_current")}
      <input disabled type="text" value={formatCurrency(listing.income)} />
    </label>
    <label for="income">
      {t("listings_table.adjust_income_new_label")}
      <input
        id="income"
        inputmode="decimal"
        min="0"
        name="income"
        step="0.01"
        type="number"
        value={toMajorUnits(listing.income)}
      />
    </label>
    <p>
      <small>
        <a href={`/admin/listing/${listing.id}#income-ledger`}>
          {t("listings_table.income_ledger_link")}
        </a>
      </small>
    </p>
    <SubmitButton icon="save">
      {t("listings_table.adjust_income_submit")}
    </SubmitButton>
  </CsrfForm>
);

const ListingRunningTotalsSection = ({
  aggregateRecalculation,
  listing,
}: {
  aggregateRecalculation?: ListingAggregateRecalculation;
  listing: ListingWithCount;
}): JSX.Element => (
  <fieldset class="listing-section">
    <legend>{t("listings_table.running_totals")}</legend>
    <div class="stack">
      <ListingAggregateMismatchNotice
        actionHref={`/admin/listings/recalculate/${listing.id}`}
        aggregateRecalculation={aggregateRecalculation}
      />
      <p>
        <small>{t("listings_table.running_totals_note")}</small>
      </p>
      <Raw
        html={renderFields(
          listingAggregateFields,
          listingAggregateToFieldValues(listing),
        )}
      />
      <p>
        <a href={`/admin/listings/recalculate/${listing.id}`}>
          {t("listings_table.recalculate_totals")}
        </a>
      </p>
    </div>
  </fieldset>
);

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

export const adminListingRecalculatePage = (
  listing: ListingWithCount,
  snapshot: ListingAggregateRecalculation,
  session: AdminSession,
  error?: string,
  success?: string,
): string =>
  adminRecalculatePage({
    action: `/admin/listings/recalculate/${listing.id}`,
    active: "/admin/",
    currentLabel: t("listings_table.recalculate_current"),
    description: t("listings_table.recalculate_description"),
    error,
    recalculatedLabel: t("listings_table.recalculate_from_attendees"),
    rows: listingRecalculateRows(snapshot),
    session,
    submitLabel: t("listings_table.recalculate_save"),
    success,
    title: t("listings_table.recalculate_listing_title", {
      name: listing.name,
    }),
  });

/** Listing fields with autofocus on the name field */
const getListingFieldsWithAutofocus = (): Field[] =>
  pipe(
    map(
      (f: Field): Field => (f.name === "name" ? { ...f, autofocus: true } : f),
    ),
  )(getListingFields());

// ---------------------------------------------------------------------------
// Sectioned listing form
//
// The listing form is grouped into labelled <fieldset> sections plus a
// collapsible Advanced <details> for the technical fields most owners never
// touch. Each array below fixes the field order within its section; names
// absent from the assembled field list (builder-only or storage-only fields,
// or slug on the create form) are skipped. The "Booking Duration & Day Prices"
// section is assembled inline because it interleaves the day-prices fieldset
// and the edit-only duration-change warning.
//
// Conditional visibility (daily-only fields, day prices, max price) is handled
// entirely in CSS via :has() — see the form rules in style.scss. The day-prices
// block sits right under the "Customisable Days" checkbox so enabling it
// reveals the prices in place.
// ---------------------------------------------------------------------------

const BASICS_FIELDS = [
  "name",
  "listing_type",
  "description",
  "date",
  "location",
  "image",
  "attachment",
] as const;

const TICKET_FIELDS = [
  "max_attendees",
  "max_quantity",
  "closes_at",
  "unit_price",
  "can_pay_more",
  "max_price",
] as const;

const DAILY_FIELDS = [
  "bookable_days",
  "minimum_days_before",
  "maximum_days_after",
] as const;

const OPTION_FIELDS = [
  "fields",
  "non_transferable",
  "purchase_only",
  "uses_logistics",
  "hidden",
] as const;

const ADVANCED_FIELDS = [
  "thank_you_url",
  "webhook_url",
  "months_per_unit",
  "initial_site_months",
  "assign_built_site",
  "slug",
] as const;

/**
 * Whether the Advanced section should render expanded. Open it when any of its
 * fields already carries a value, so editors don't lose track of a configured
 * webhook or renewal tier. Slug is deliberately excluded: it is always set, so
 * counting it would force the section open on every edit. Builder-only fields
 * only count when the builder is enabled (otherwise they aren't rendered).
 */
const advancedSectionHasValues = (
  listing: ListingWithCount,
  builderEnabled: boolean,
): boolean => {
  if (listing.thank_you_url || listing.webhook_url) return true;
  return (
    builderEnabled &&
    (listing.months_per_unit > 0 ||
      listing.initial_site_months > 0 ||
      listing.assign_built_site)
  );
};

/** Edit-only warning shown next to the booking-duration field: changing it
 * rewrites end_at on every existing booking. Wired up by initDurationWarning. */
const DurationWarning = ({
  listing,
}: {
  listing: ListingWithCount;
}): JSX.Element => (
  <div
    data-duration-original={listing.duration_days}
    hidden
    id="duration-warning"
  >
    <p>
      <strong>{t("listings_table.warning")}:</strong>{" "}
      {t("listings_table.duration_warning_message")}
    </p>
    <label>
      <input id="duration-warning-confirm" type="checkbox" />
      {t("listings_table.i_understand")}
    </label>
  </div>
);

/**
 * Render the body of a listing form (create, duplicate, or edit) as grouped
 * sections. The surrounding <form>, page heading, and submit button differ per
 * page and stay in the individual page functions.
 */
const ListingFormSections = ({
  fields,
  values,
  groups,
  selectedGroupId,
  dayPricesListing,
  durationWarning,
  imagePreview,
  advancedOpen,
}: {
  fields: Field[];
  values: FieldValues;
  groups: Group[];
  selectedGroupId: number;
  /** Listing whose duration sizes the day-price rows (absent on create). */
  dayPricesListing?: ListingWithCount;
  /** Pre-rendered edit-only duration-change warning ("" on create/duplicate). */
  durationWarning: string;
  /** Pre-rendered edit-only current-image preview ("" otherwise). */
  imagePreview: string;
  advancedOpen: boolean;
}): JSX.Element => {
  const fieldMap = new Map<string, Field>(fields.map((f) => [f.name, f]));
  const sec = (names: readonly string[]): string =>
    renderFields(mapNotNullish((n: string) => fieldMap.get(n))(names), values);
  return (
    <>
      <fieldset class="listing-section">
        <legend>{t("listings_table.basics")}</legend>
        <div class="stack">
          <Raw html={sec(BASICS_FIELDS)} />
          {imagePreview && <Raw html={imagePreview} />}
          <ListingGroupSelect
            groups={groups}
            selectedGroupId={selectedGroupId}
          />
        </div>
      </fieldset>

      <fieldset class="listing-section">
        <legend>{t("listings_table.tickets_pricing")}</legend>
        <div class="stack">
          <Raw html={sec(TICKET_FIELDS)} />
        </div>
      </fieldset>

      <fieldset class="listing-section listing-section--daily">
        <legend>{t("listings_table.daily_scheduling")}</legend>
        <div class="stack">
          <Raw html={sec(DAILY_FIELDS)} />
        </div>
      </fieldset>

      <fieldset class="listing-section">
        <legend>{t("listings_table.booking_duration_day_prices")}</legend>
        <div class="stack">
          <Raw html={sec(["duration_days"])} />
          {durationWarning && <Raw html={durationWarning} />}
          <Raw html={sec(["customisable_days"])} />
          <Raw html={renderDayPricesFieldset(dayPricesListing)} />
        </div>
      </fieldset>

      <fieldset class="listing-section">
        <legend>{t("listings_table.options_visibility")}</legend>
        <div class="stack">
          <Raw html={sec(OPTION_FIELDS)} />
        </div>
      </fieldset>

      <details class="listing-advanced" open={advancedOpen}>
        <summary>{t("listings_table.advanced_settings")}</summary>
        <div class="stack">
          <Raw html={sec(ADVANCED_FIELDS)} />
        </div>
      </details>
    </>
  );
};

/**
 * Admin listing create page
 */
export const adminListingNewPage = (
  groups: Group[],
  session: AdminSession,
  error?: string,
): string => {
  const storageEnabled = isStorageEnabled();
  const builderEnabled = isBuilderEnabled();
  const fields = [
    ...getListingFields(),
    ...(settings.hasLogistics ? [logisticsField] : []),
    ...(builderEnabled
      ? [
          getMonthsPerUnitField(),
          getInitialSiteMonthsField(),
          getAssignBuiltSiteField(),
        ]
      : []),
    ...(storageEnabled ? [getImageField(), getAttachmentField()] : []),
  ];
  return String(
    <Layout title={t("listings_table.add_listing")}>
      <AdminNav active="/admin/" session={session} />

      <CsrfForm action="/admin/listing" enctype="multipart/form-data">
        <h1>{t("listings_table.add_listing")}</h1>
        <Flash error={error} />
        <ListingFormSections
          advancedOpen={!!error}
          durationWarning=""
          fields={fields}
          groups={groups}
          imagePreview=""
          selectedGroupId={0}
          values={{}}
        />
        <SubmitButton icon="plus">
          {t("listings_table.create_listing")}
        </SubmitButton>
      </CsrfForm>
    </Layout>,
  );
};

/**
 * Admin duplicate listing page - create form pre-filled with existing listing settings
 */
export const adminDuplicateListingPage = (
  listing: ListingWithCount,
  groups: Group[],
  session: AdminSession,
): string => {
  const values = listingToFieldValues(listing);
  values.name = "";
  const builderEnabled = isBuilderEnabled();
  const storageEnabled = isStorageEnabled();
  const dupFields = [
    ...getListingFieldsWithAutofocus(),
    ...(settings.hasLogistics ? [logisticsField] : []),
    ...(builderEnabled
      ? [
          getMonthsPerUnitField(),
          getInitialSiteMonthsField(),
          getAssignBuiltSiteField(),
        ]
      : []),
    ...(storageEnabled ? [getImageField(), getAttachmentField()] : []),
  ];

  return String(
    <Layout
      title={t("listings_table.duplicate_listing_title", {
        name: listing.name,
      })}
    >
      <AdminNav active="/admin/" session={session} />
      <div class="prose">
        <h2>{t("listings_table.duplicate_listing")}</h2>
        <p>
          {t("listings_table.creating_new_listing_based_on", {
            name: listing.name,
          })}
        </p>
      </div>
      <CsrfForm action="/admin/listing" enctype="multipart/form-data">
        <ListingFormSections
          advancedOpen={advancedSectionHasValues(listing, builderEnabled)}
          dayPricesListing={listing}
          durationWarning=""
          fields={dupFields}
          groups={groups}
          imagePreview=""
          selectedGroupId={listing.group_id}
          values={values}
        />
        <SubmitButton icon="plus">
          {t("listings_table.create_listing")}
        </SubmitButton>
      </CsrfForm>
    </Layout>,
  );
};

/**
 * Admin listing edit page
 */
export const adminListingEditPage = (
  listing: ListingWithCount,
  groups: Group[],
  session: AdminSession,
  error?: string,
  aggregateRecalculation?: ListingAggregateRecalculation,
  success?: string,
): string => {
  const storageEnabled = isStorageEnabled();
  const builderEnabled = isBuilderEnabled();
  // Slug is editable only here (auto-generated on create), so it lives in the
  // edit form's field list rather than the shared definitions.
  const fields = [
    ...getListingFields(),
    ...(settings.hasLogistics ? [logisticsField] : []),
    ...(builderEnabled
      ? [
          getMonthsPerUnitField(),
          getInitialSiteMonthsField(),
          getAssignBuiltSiteField(),
        ]
      : []),
    ...(storageEnabled ? [getImageField(), getAttachmentField()] : []),
    getSlugField(),
  ];
  const imagePreview =
    storageEnabled && listing.image_url
      ? renderListingImage(listing, "listing-image-full")
      : "";
  const durationWarning = String(<DurationWarning listing={listing} />);
  return String(
    <Layout
      title={t("listings_table.edit_listing_title", { name: listing.name })}
    >
      <AdminNav active="/admin/" session={session} />
      <Flash error={error} success={success} />
      <CsrfForm
        action={`/admin/listing/${listing.id}/edit`}
        enctype="multipart/form-data"
        id="listing-edit-form"
      >
        <ListingFormSections
          advancedOpen={
            advancedSectionHasValues(listing, builderEnabled) || !!error
          }
          dayPricesListing={listing}
          durationWarning={durationWarning}
          fields={fields}
          groups={groups}
          imagePreview={imagePreview}
          selectedGroupId={listing.group_id}
          values={listingToFieldValues(listing)}
        />
        <ListingRunningTotalsSection
          aggregateRecalculation={aggregateRecalculation}
          listing={listing}
        />
        <SubmitButton icon="save" id="listing-edit-submit">
          {t("common.save_changes")}
        </SubmitButton>
      </CsrfForm>
      <ListingIncomeAdjustSection listing={listing} />
      {storageEnabled && listing.image_url && (
        <CsrfForm action={`/admin/listing/${listing.id}/image/delete`}>
          <SubmitButton class="secondary" icon="trash-2">
            {t("listings_table.remove_image")}
          </SubmitButton>
        </CsrfForm>
      )}
      {storageEnabled && listing.attachment_name && (
        <div class="attachment-info">
          <p>
            {t("listings_table.current_attachment", {
              name: listing.attachment_name,
            })}
          </p>
          <CsrfForm action={`/admin/listing/${listing.id}/attachment/delete`}>
            <SubmitButton class="secondary" icon="trash-2">
              {t("listings_table.remove_attachment")}
            </SubmitButton>
          </CsrfForm>
        </div>
      )}
    </Layout>,
  );
};

/**
 * Admin delete listing confirmation page
 */
export const adminDeleteListingPage = (
  listing: ListingWithCount,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout
      title={t("listings_table.delete_listing_title", { name: listing.name })}
    >
      <AdminNav active="/admin/" session={session} />
      <Flash error={error} />

      <ConfirmForm
        action={`/admin/listing/${listing.id}/delete`}
        buttonText={t("listings_table.delete_listing")}
        label={t("listings_table.listing_name")}
        name={listing.name}
      >
        <p>
          <strong>{t("listings_table.warning")}:</strong>{" "}
          {t("listings_table.delete_warning_text", {
            count: listing.attendee_count,
          })}
        </p>
        <p>
          {t("listings_table.delete_confirmation_text", { name: listing.name })}
        </p>
      </ConfirmForm>
    </Layout>,
  );

/**
 * Admin deactivate listing confirmation page
 */
export const adminDeactivateListingPage = (
  listing: ListingWithCount,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout
      title={t("listings_table.deactivate_listing_title", {
        name: listing.name,
      })}
    >
      <AdminNav active="/admin/" session={session} />
      <Flash error={error} />

      <ConfirmForm
        action={`/admin/listing/${listing.id}/deactivate`}
        buttonText={t("listings_table.deactivate_listing")}
        label={t("listings_table.listing_name")}
        name={listing.name}
      >
        <p>
          <strong>{t("listings_table.warning")}:</strong>{" "}
          {t("listings_table.deactivate_warning")}
        </p>
        <ul>
          <li>{t("listings_table.deactivate_effect_404")}</li>
          <li>{t("listings_table.deactivate_effect_prevent_registrations")}</li>
          <li>{t("listings_table.deactivate_effect_reject_payments")}</li>
        </ul>
        <p>{t("listings_table.existing_attendees_not_affected")}</p>
        <p>
          {t("listings_table.deactivate_confirmation_text", {
            name: listing.name,
          })}
        </p>
      </ConfirmForm>
    </Layout>,
  );

/**
 * Admin reactivate listing confirmation page
 */
export const adminReactivateListingPage = (
  listing: ListingWithCount,
  session: AdminSession,
  error?: string,
): string =>
  String(
    <Layout
      title={t("listings_table.reactivate_listing_title", {
        name: listing.name,
      })}
    >
      <AdminNav active="/admin/" session={session} />
      <Flash error={error} />

      <ConfirmForm
        action={`/admin/listing/${listing.id}/reactivate`}
        buttonText={t("listings_table.reactivate_listing")}
        danger={false}
        label={t("listings_table.listing_name")}
        name={listing.name}
      >
        <p>{t("listings_table.reactivate_will_make_available")}</p>
        <p>
          {t(
            "listings_table.public_page_accessible_new_attendees_can_register",
          )}
        </p>
        <p>
          {t("listings_table.reactivate_confirmation_text", {
            name: listing.name,
          })}
        </p>
      </ConfirmForm>
    </Layout>,
  );
