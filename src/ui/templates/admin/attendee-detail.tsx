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
import { formatDateRangeLabel } from "#shared/dates.ts";
import type { QuestionWithAnswers } from "#shared/db/questions.ts";
import { type Child, Raw } from "#shared/jsx/jsx-runtime.ts";
import { questionTextFlat } from "#templates/admin/questions.tsx";
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
      ? {
          answer: picks.map((a) => a.text).join(", "),
          question: questionTextFlat(q.text),
        }
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
