/* jscpd:ignore-start */

import { filter, joinStrings, map, pipe } from "#fp";
import { t } from "#i18n";
import type { AttendeeFilter } from "#shared/attendee-list-controls.ts";
import { targetQuery } from "#shared/bulk-email.ts";
import { formatDatetimeShort } from "#shared/dates.ts";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { renderFields } from "#shared/forms/rendering.tsx";
import { isIncompletePayment } from "#shared/incomplete-payment.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import {
  type Attendee,
  type AttendeeTableRow,
  availableDayCounts,
  hasTicketQuantity,
  isPaidListing,
  type ListingWithCount,
} from "#shared/types.ts";
import { attendeeTableOptions } from "#templates/admin/attendee-table-block.tsx";
import { sumQuantity } from "#templates/admin/detail-rows.tsx";
import { FilteredAttendeeTable } from "#templates/attendee-table/controls.tsx";
import type { TableQuestionData } from "#templates/attendee-table/types.ts";
import { quantityHeader } from "#templates/components/header-row.tsx";
import { ProseArticle } from "#templates/components/prose-article.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { colClass } from "#templates/components/table-columns.ts";
import { TableScroll } from "#templates/components/table-scroll.tsx";
import { getAddAttendeeFields } from "#templates/fields/add-attendee.ts";
import type { RosterListView } from "./types.ts";

/* jscpd:ignore-end */

/** Whether the day's recipient query would find this booking: a ticket, an
 * email, and a stored `[date, end_date)` range that covers the day. The stored
 * range is what the query reads, and a booking without one is not counted for
 * any day anywhere, capacity included. */
const wouldBeEmailed = (attendee: Attendee, day: string): boolean =>
  hasTicketQuantity(attendee) &&
  attendee.email.trim() !== "" &&
  attendee.date !== null &&
  attendee.end_date !== null &&
  attendee.date <= day &&
  day < attendee.end_date;

/** Where the roster's "Email this date's attendees" action goes, or `undefined`
 * when the compose page would not open: no day chosen, a viewer who is not an
 * owner (`/admin/emails` is owner-only), or a day whose recipient set is empty
 * (the compose page 404s on one). */
export const emailDayHrefFor = (
  listingId: number,
  dateFilter: string | null,
  isOwner: boolean,
  dayAttendees: Attendee[],
): string | undefined => {
  if (!dateFilter || !isOwner) return;
  return dayAttendees.some((a) => wouldBeEmailed(a, dateFilter))
    ? `/admin/emails${targetQuery({ day: dateFilter, kind: "listing-day", listingId })}`
    : undefined;
};

const keepByRosterFilter: Record<AttendeeFilter, (a: Attendee) => boolean> = {
  all: () => true,
  in: (a) => a.checked_in && hasTicketQuantity(a),
  out: (a) => !a.checked_in && hasTicketQuantity(a),
};

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

export const AttendeesSection = ({
  list,
  allowedDomain,
  emailDayHref,
  returnUrl,
  tableRows,
  questionData,
  phonePrefix,
}: {
  list: RosterListView;
  allowedDomain: string;
  /** Where "Email this date's attendees" goes; undefined withholds the action. */
  emailDayHref: string | undefined;
  returnUrl: string;
  tableRows: AttendeeTableRow[];
  questionData: TableQuestionData | undefined;
  phonePrefix: string | undefined;
}): JSX.Element => (
  <ProseArticle heading={<h2 id="attendees">{t("terms.attendees")}</h2>}>
    <FilteredAttendeeTable
      actions={
        emailDayHref && (
          <a href={emailDayHref}>{t("listings_table.email_this_date")}</a>
        )
      }
      options={attendeeTableOptions({
        activeFilter: list.state.checkin,
        allowedDomain,
        phonePrefix,
        // A chosen sort was applied by the caller; the table's own
        // date-and-name order applies otherwise.
        presorted: list.state.sort !== null,
        questionData,
        returnUrl,
        rows: tableRows,
        showDate: list.setup.withDates,
        showListing: false,
      })}
      view={list}
    />
  </ProseArticle>
);

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
