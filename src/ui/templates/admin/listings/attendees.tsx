/* jscpd:ignore-start */

import { filter, joinStrings, map, pipe } from "#fp";
import { t } from "#i18n";
import { formatDatetimeShort } from "#shared/dates.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { renderFields, renderSelectOptions } from "#shared/forms/rendering.tsx";
import { isIncompletePayment } from "#shared/incomplete-payment.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import {
  type Attendee,
  availableDayCounts,
  hasTicketQuantity,
  isPaidListing,
  type ListingWithCount,
} from "#shared/types.ts";
import {
  AttendeeTableBlock,
  attendeeTableOptions,
} from "#templates/admin/attendee-table-block.tsx";
import { sumQuantity } from "#templates/admin/detail-rows.tsx";
import type {
  AttendeeTableRow,
  TableQuestionData,
} from "#templates/attendee-table.tsx";
import { quantityHeader } from "#templates/components/header-row.tsx";
import { ProseArticle } from "#templates/components/prose-article.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { colClass } from "#templates/components/table-columns.ts";
import { TableScroll } from "#templates/components/table-scroll.tsx";
import { getAddAttendeeFields } from "#templates/fields/add-attendee.ts";
import type { AttendeeFilter, DateOption } from "./types.ts";

/* jscpd:ignore-end */

const keepByRosterFilter: Record<AttendeeFilter, (a: Attendee) => boolean> = {
  all: () => true,
  in: (a) => a.checked_in && hasTicketQuantity(a),
  out: (a) => !a.checked_in && hasTicketQuantity(a),
};

const ROSTER_FILTER_LINKS: { filter: AttendeeFilter; labelKey: string }[] = [
  { filter: "all", labelKey: "listings_table.all" },
  { filter: "in", labelKey: "common.checked_in" },
  { filter: "out", labelKey: "listings_table.checked_out" },
];

const hasKnownPaymentReference =
  (paymentReferenceAttendeeIds: ReadonlySet<number>) =>
  (attendee: Attendee): boolean =>
    attendee.payment_id !== "" || paymentReferenceAttendeeIds.has(attendee.id);

const hasIncompletePayment = (
  paymentReferenceAttendeeIds: ReadonlySet<number>,
): ((attendee: Attendee) => boolean) => {
  const knowsPayment = hasKnownPaymentReference(paymentReferenceAttendeeIds);
  return (attendee: Attendee): boolean =>
    isIncompletePayment(attendee, true, knowsPayment(attendee));
};

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
      <td class={colClass("quantity")}>{attendee.quantity}</td>
      <td>{formatDatetimeShort(attendee.created)}</td>
      <td class={colClass("actions")}>
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

type FailedPaymentsProps = {
  attendees: Attendee[];
  listingId: number;
};

const FailedPaymentsTable = ({
  attendees,
  listingId,
}: FailedPaymentsProps): string =>
  String(
    <table>
      <thead>
        <tr>
          <th>{t("common.name")}</th>
          {quantityHeader("common.qty")}
          <th>{t("common.registered")}</th>
          <th class={colClass("actions")}></th>
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

export const filterAttendees = (
  attendees: Attendee[],
  activeFilter: AttendeeFilter,
): Attendee[] => filter(keepByRosterFilter[activeFilter])(attendees);

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

export const rosterHref = (
  listingId: number,
  activeFilter: AttendeeFilter,
  dateFilter: string | null,
): string => {
  const params = new URLSearchParams();
  if (activeFilter !== "all") params.set("filter", activeFilter);
  if (dateFilter) params.set("date", dateFilter);
  const qs = params.toString();
  return `/admin/listing/${listingId}/attendees${qs ? `?${qs}` : ""}`;
};

const DateSelector = ({
  listingId,
  activeFilter,
  dateFilter,
  dates,
}: {
  listingId: number;
  activeFilter: AttendeeFilter;
  dateFilter: string | null;
  dates: DateOption[];
}): string => {
  const options = renderSelectOptions([
    {
      label: t("listings_table.all_dates"),
      selected: !dateFilter,
      value: rosterHref(listingId, activeFilter, null),
    },
    ...dates.map((d) => ({
      label: d.label,
      selected: dateFilter === d.value,
      value: rosterHref(listingId, activeFilter, d.value),
    })),
  ]);
  return `<select data-nav-select aria-label="${t(
    "listings_table.filter_by_date",
  )}">${options}</select>`;
};

const AttendeesFilterLinks = ({
  listingId,
  dateFilter,
  activeFilter,
}: {
  listingId: number;
  dateFilter: string | null;
  activeFilter: AttendeeFilter;
}): JSX.Element => (
  <p>
    <Raw
      html={ROSTER_FILTER_LINKS.map(({ filter, labelKey }) =>
        FilterLink({
          active: activeFilter === filter,
          href: rosterHref(listingId, filter, dateFilter),
          label: t(labelKey),
        }),
      ).join(" / ")}
    />
  </p>
);

export const AttendeesSection = ({
  listingId,
  allowedDomain,
  isDaily,
  availableDates,
  activeFilter,
  dateFilter,
  basePath,
  returnUrl,
  tableRows,
  questionData,
  phonePrefix,
}: {
  listingId: number;
  allowedDomain: string;
  isDaily: boolean;
  availableDates: DateOption[];
  activeFilter: AttendeeFilter;
  dateFilter: string | null;
  basePath: string;
  returnUrl: string;
  tableRows: AttendeeTableRow[];
  questionData: TableQuestionData | undefined;
  phonePrefix: string | undefined;
}): JSX.Element => {
  const exportParams = new URLSearchParams();
  if (dateFilter) exportParams.set("date", dateFilter);
  if (activeFilter !== "all") exportParams.set("checkin", activeFilter);
  const exportQuery = exportParams.toString();
  const exportHref = `${basePath}/export${
    exportQuery ? `?${exportQuery}` : ""
  }`;
  return (
    <ProseArticle heading={<h2 id="attendees">{t("terms.attendees")}</h2>}>
      {isDaily && availableDates.length > 0 && (
        <Raw
          html={DateSelector({
            activeFilter,
            dateFilter,
            dates: availableDates,
            listingId,
          })}
        />
      )}
      <AttendeesFilterLinks
        activeFilter={activeFilter}
        dateFilter={dateFilter}
        listingId={listingId}
      />
      <AttendeeTableBlock
        actions={<a href={exportHref}>{t("listings_table.export_csv")}</a>}
        options={attendeeTableOptions({
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
    </ProseArticle>
  );
};

export const FailedPaymentsSection = ({
  attendees,
  listingId,
}: FailedPaymentsProps): JSX.Element => (
  <ProseArticle
    heading={
      <h2 id="failed-payments">{t("listings_table.failed_payments")}</h2>
    }
    prose={
      <p>
        {t("listings_table.attendees_with_unresolved_payments", {
          count: attendees.length,
        })}
      </p>
    }
  >
    <TableScroll>
      <Raw html={FailedPaymentsTable({ attendees, listingId })} />
    </TableScroll>
  </ProseArticle>
);

export const AddAttendeeSection = ({
  listing,
  childNames = [],
}: {
  listing: ListingWithCount;
  childNames?: string[];
}): JSX.Element => (
  <article>
    <h2 id="add-attendee">{t("listings_table.add_attendee")}</h2>
    {childNames.length > 0 && (
      <p class="notice">
        {t("listings_table.add_attendee_parent_warning", {
          children: childNames.join(", "),
        })}
      </p>
    )}
    <SaveForm
      action={`/admin/listing/${listing.id}/attendee`}
      submitIcon="plus"
      submitLabel={t("listings_table.add_attendee")}
    >
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
    </SaveForm>
  </article>
);

export const completePaymentAttendees = (
  listing: ListingWithCount,
  attendees: Attendee[],
  paymentReferenceAttendeeIds: ReadonlySet<number> = new Set(),
): Attendee[] => {
  const isIncomplete = hasIncompletePayment(paymentReferenceAttendeeIds);
  return isPaidListing(listing)
    ? filter((a: Attendee) => !isIncomplete(a))(attendees)
    : attendees;
};

export const attendeeStatsForListing = (
  listing: ListingWithCount,
  attendees: Attendee[],
  hasPaidListing: boolean,
  paymentReferenceAttendeeIds: ReadonlySet<number> = new Set(),
): {
  incompleteAttendees: Attendee[];
  completeAttendees: Attendee[];
  adjustedCount: number;
  completeQuantitySum: number;
} => {
  const incompleteAttendees = hasPaidListing
    ? filter(hasIncompletePayment(paymentReferenceAttendeeIds))(attendees)
    : [];
  const completeAttendees = completePaymentAttendees(
    listing,
    attendees,
    paymentReferenceAttendeeIds,
  );
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
