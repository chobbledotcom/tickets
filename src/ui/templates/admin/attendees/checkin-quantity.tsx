/** The quantity page a roster Check In / Check Out link opens for a booking
 * line that holds more than one ticket: pick how many tickets to admit or
 * release, then submit. The check-in select offers what the line still
 * owes; the check-out select offers what it still holds admitted. */

import { remainingTickets } from "#booking/remaining-tickets.ts";
import { t } from "#i18n";
import { CsrfForm } from "#shared/forms/csrf-form.tsx";
import { ReturnUrlField } from "#shared/return-url-field.tsx";
import { renderAdminPage } from "#templates/admin/admin-page.tsx";
import { ticketCountText } from "#templates/admin/scanner.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import type { AdminSession, DisplayAttendee } from "#types";

/** What one direction's count form reads. */
type CountFormProps = {
  action: string;
  checkIn: boolean;
  countId: string;
  filter: string;
  labelKey: string;
  max: number;
  returnUrl: string | undefined;
  submitLabel: string;
};

/** One direction's form: a count select plus its submit. */
const CountForm = ({
  action,
  checkIn,
  countId,
  filter,
  labelKey,
  max,
  returnUrl,
  submitLabel,
}: CountFormProps): JSX.Element => (
  <CsrfForm action={action} class="stack">
    <input name="check_in" type="hidden" value={checkIn ? "true" : "false"} />
    <input name="return_filter" type="hidden" value={filter} />
    <ReturnUrlField returnUrl={returnUrl} />
    <label for={countId}>{t(labelKey)}</label>
    <select id={countId} name="quantity">
      {Array.from({ length: max }, (_, index) => {
        const count = index + 1;
        return (
          <option selected={count === max} value={String(count)}>
            {ticketCountText(count)}
          </option>
        );
      })}
    </select>
    <SubmitButton icon="check">{submitLabel}</SubmitButton>
  </CsrfForm>
);

/** Render the quantity page for one booking line. */
export const attendeeCheckinQuantityPage = ({
  attendee,
  filter,
  listingName,
  returnUrl,
  session,
}: {
  attendee: DisplayAttendee;
  filter: string;
  listingName: string;
  returnUrl: string | undefined;
  session: AdminSession;
}): string => {
  const remaining = remainingTickets(attendee);
  const headingKey =
    remaining > 0
      ? "admin.checkin_quantity.title_in"
      : "admin.checkin_quantity.title_out";
  const action = `/admin/listing/${attendee.listing_id}/attendee/${attendee.id}/checkin`;
  return renderAdminPage(
    "/admin/",
    session,
    t(headingKey),
    <>
      <div class="prose">
        <h1>{t(headingKey)}</h1>
        <p>
          {t("admin.checkin_quantity.current", {
            checked: attendee.checked_in,
            listing: listingName,
            name: attendee.name,
            total: attendee.quantity,
          })}
        </p>
      </div>
      {remaining > 0 ? (
        <CountForm
          action={action}
          checkIn
          countId="checkin-admit-count"
          filter={filter}
          labelKey="admin.scanner.quantity_label"
          max={remaining}
          returnUrl={returnUrl}
          submitLabel={t("admin.attendee_table.check_in")}
        />
      ) : undefined}
      {attendee.checked_in > 0 ? (
        <CountForm
          action={action}
          checkIn={false}
          countId="checkin-release-count"
          filter={filter}
          labelKey="admin.checkin_quantity.check_out_label"
          max={attendee.checked_in}
          returnUrl={returnUrl}
          submitLabel={t("admin.attendee_table.check_out")}
        />
      ) : undefined}
    </>,
  );
};
