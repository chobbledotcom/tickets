/**
 * Read-only attendee views shown at the top of the edit attendee page.
 *
 * `AttendeeDetail` is the single-attendee counterpart to the multi-attendee
 * `AttendeeTable`: instead of one row per attendee it lays a single attendee's
 * details out vertically as a key/value table. `AttendeeAnswersTable` renders
 * the attendee's custom-question answers, and `AttendeeLogSection` wraps the
 * shared activity-log table (filtered to this attendee) in a collapsed
 * details/summary disclosure.
 */

import { compact, mapNotNullish, sumOf } from "#fp";
import { t } from "#i18n";
import type { AttendeeBooking } from "#routes/admin/attendee-form-model.ts";
import { formatDateRangeLabel, formatDatetimeShort } from "#shared/dates.ts";
import type { ActivityLogEntry } from "#shared/db/activityLog.ts";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import { type Child, Raw } from "#shared/jsx/jsx-runtime.ts";
import type { Attendee } from "#shared/types.ts";
import { ActivityLogTable } from "#templates/admin/activityLog.tsx";
import {
  type AccountLedgerData,
  AccountStatementSection,
} from "#templates/admin/ledger.tsx";
import { MapsLinks } from "#templates/components/maps-links.tsx";
import { PhoneLinks } from "#templates/components/phone-links.tsx";
import { colClass } from "#templates/components/table-columns.ts";

/** One key/value row of a detail table. */
const DetailTableRow = ({
  label,
  children,
}: {
  label: string;
  children: Child;
}): JSX.Element => (
  <tr>
    <th scope="row">{label}</th>
    <td>{children}</td>
  </tr>
);

/** Preserve the author's line breaks for multi-line free text. */
const Multiline = ({ text }: { text: string }): JSX.Element => (
  <span style="white-space:pre-wrap">{text}</span>
);

/**
 * The main read-only details table for a single attendee. Optional contact
 * fields are omitted when blank so the table only spells out what's on file.
 */
export const AttendeeDetail = ({
  attendee,
  allowedDomain,
  phonePrefix,
  hasRealLine,
}: {
  attendee: Attendee;
  allowedDomain: string;
  phonePrefix: string;
  /** Whether the attendee has any real (quantity > 0) booking. A no-quantity-only
   * attendee has no live customer ticket — its /t page 404s — so we show the
   * no-quantity indicator instead of a link that fails on click. */
  hasRealLine: boolean;
}): JSX.Element => {
  const rows = compact([
    <DetailTableRow label={t("common.name")}>{attendee.name}</DetailTableRow>,
    attendee.email ? (
      <DetailTableRow label={t("common.email")}>
        <a href={`mailto:${attendee.email}`}>{attendee.email}</a>
      </DetailTableRow>
    ) : null,
    attendee.phone ? (
      <DetailTableRow label={t("common.phone")}>
        <PhoneLinks phone={attendee.phone} phonePrefix={phonePrefix} />
      </DetailTableRow>
    ) : null,
    attendee.address ? (
      <DetailTableRow label={t("common.address")}>
        <Multiline text={attendee.address} />
        <MapsLinks query={attendee.address} />
      </DetailTableRow>
    ) : null,
    attendee.special_instructions ? (
      <DetailTableRow label={t("common.special_instructions")}>
        <Multiline text={attendee.special_instructions} />
      </DetailTableRow>
    ) : null,
    <DetailTableRow label={t("terms.ticket")}>
      {hasRealLine ? (
        <a href={`https://${allowedDomain}/t/${attendee.ticket_token}`}>
          {attendee.ticket_token}
        </a>
      ) : (
        <span class="muted small">{t("admin.attendee_table.no_quantity")}</span>
      )}
    </DetailTableRow>,
    <DetailTableRow label={t("common.registered")}>
      {formatDatetimeShort(attendee.created)}
    </DetailTableRow>,
  ]);
  return (
    <div class="table-scroll">
      <table class="listing-details-table">
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
};

/**
 * "Checked in" / "Refunded" status badges for a booking, or null when neither
 * applies. Shared by the read-only bookings summary and the listing-editor rows.
 */
export const BookingStatusBadges = ({
  checkedIn,
  refunded,
}: {
  checkedIn: boolean;
  refunded: boolean;
}): JSX.Element | null => {
  const badges = compact([
    checkedIn ? (
      <span class="badge">{t("attendee_form.checked_in")}</span>
    ) : null,
    refunded ? (
      <span class="badge danger">{t("attendee_form.refunded")}</span>
    ) : null,
  ]);
  return badges.length > 0 ? (
    <div class="muted small">
      <Raw html={badges.join(" ")} />
    </div>
  ) : null;
};

/**
 * Read-only summary of the listings an attendee currently books, shown as a
 * table near the top of the edit page: one row per booking with its quantity,
 * dates (for daily listings), and check-in / refund status, plus a total ticket
 * count. Returns null when nothing is booked so the caller can drop the section.
 */
export const AttendeeBookingsTable = ({
  bookings,
}: {
  bookings: AttendeeBooking[];
}): JSX.Element | null => {
  if (bookings.length === 0) return null;
  const totalQuantity = sumOf((b: AttendeeBooking) => b.quantity)(bookings);
  // A folded child row carries the parent listing it was chosen under; the
  // parent is booked in this same order, so resolve its name from the row set.
  const nameByListingId = new Map(
    bookings.map((b) => [b.listingId, b.listingName]),
  );
  // The reverse link: each parent's chosen add-on children, so the parent row
  // shows what was folded under it (usability #5).
  const childNamesByParentId = new Map<number, string[]>();
  for (const b of bookings) {
    if (b.parentListingId > 0) {
      const names =
        childNamesByParentId.get(b.parentListingId) ??
        childNamesByParentId.set(b.parentListingId, []).get(b.parentListingId)!;
      names.push(b.listingName);
    }
  }
  return (
    <>
      <h3>{t("terms.bookings")}</h3>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t("terms.listing")}</th>
              <th>{t("common.date")}</th>
              <th class={colClass("quantity")}>{t("common.quantity")}</th>
              <th>{t("common.status")}</th>
            </tr>
          </thead>
          <tbody>
            {bookings.map((booking) => (
              <tr>
                <td>
                  <a href={`/admin/listing/${booking.listingId}`}>
                    {booking.listingName}
                  </a>
                  {booking.listingActive ? null : (
                    <span class="muted small"> ({t("common.inactive")})</span>
                  )}
                  {booking.parentListingId > 0 ? (
                    <div class="muted small">
                      {t("attendee_detail.addon_under", {
                        parent:
                          nameByListingId.get(booking.parentListingId) ??
                          `#${booking.parentListingId}`,
                      })}
                    </div>
                  ) : null}
                  {childNamesByParentId.has(booking.listingId) ? (
                    <div class="muted small">
                      {t("attendee_detail.includes_addon", {
                        children: childNamesByParentId
                          .get(booking.listingId)!
                          .join(", "),
                      })}
                    </div>
                  ) : null}
                </td>
                <td>
                  {booking.startAt
                    ? formatDateRangeLabel(booking.startAt, booking.endAt)
                    : "—"}
                </td>
                <td class={colClass("quantity")}>{booking.quantity}</td>
                <td>
                  {BookingStatusBadges({
                    checkedIn: booking.checkedIn,
                    refunded: booking.refunded,
                  }) ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th colspan="2" scope="row">
                {t("attendee_detail.total")}
              </th>
              <td class={colClass("quantity")}>{totalQuantity}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
};

/**
 * The attendee's answers to custom questions, one row per answered question.
 * Returns null when the attendee has answered nothing, so the caller can drop
 * the section entirely.
 */
export const AttendeeAnswersTable = ({
  questions,
  selectedAnswerIds,
}: {
  questions: QuestionWithAnswers[];
  selectedAnswerIds: number[];
}): JSX.Element | null => {
  const selected = new Set(selectedAnswerIds);
  const answered = mapNotNullish((q: QuestionWithAnswers) => {
    const picks = q.answers.filter((a) => selected.has(a.id));
    return picks.length > 0
      ? { answer: picks.map((a) => a.text).join(", "), question: q.text }
      : null;
  })(questions);
  if (answered.length === 0) return null;
  return (
    <>
      <h3>{t("attendee_detail.answers")}</h3>
      <div class="table-scroll">
        <table class="listing-details-table">
          <tbody>
            {answered.map((row) => (
              <DetailTableRow label={row.question}>{row.answer}</DetailTableRow>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
};

/**
 * The attendee's activity log, collapsed by default. Renders the same
 * Time/Activity table the /admin/log pages use, filtered to this attendee.
 */
export const AttendeeLogSection = ({
  entries,
}: {
  entries: ActivityLogEntry[];
}): JSX.Element => (
  <details>
    <summary>{t("attendee_detail.activity_log")}</summary>
    <ActivityLogTable entries={entries} />
  </details>
);

/** The attendee's ledger account, its statement lines, and the counterparties'
 * display names — everything the embedded statement panel needs. The feature
 * loader builds these for the attendee's own account. */
export type AttendeeLedgerData = AccountLedgerData;

/**
 * The attendee's money ledger embedded on the edit page (decision 15 names the
 * edit-attendee page as a renderer surface): the same shared running-balance
 * statement the standalone /admin/ledger account page shows, scoped to this
 * attendee's account. Collapsed in a details/summary like the activity log, with
 * the balance, a "view full ledger" action row, then the scrollable statement.
 */
export const AttendeeLedgerSection = ({
  ledger,
}: {
  ledger: AttendeeLedgerData;
}): JSX.Element => (
  <details>
    <summary>{t("attendee_detail.ledger")}</summary>
    <AccountStatementSection
      account={ledger.account}
      fullLedgerHref={`/admin/ledger/${ledger.account.type}/${ledger.account.id}`}
      lines={ledger.lines}
      names={ledger.names}
      returnUrl={`/admin/attendees/${ledger.account.id}`}
    />
  </details>
);
