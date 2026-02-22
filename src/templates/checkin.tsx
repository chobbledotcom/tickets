/**
 * Check-in page templates
 * Admin view: attendee details with check-in/check-out button
 * Non-admin view: simple confirmation message
 */

import { map, pipe } from "#fp";
import { CsrfForm } from "#lib/forms.tsx";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { TokenEntry } from "#routes/token-utils.ts";
import { AttendeeTable, type AttendeeTableRow } from "#templates/attendee-table.tsx";
import { Layout } from "#templates/layout.tsx";

/** Re-export for backwards compatibility */
export type { TokenEntry as CheckinEntry };

/**
 * Admin check-in page - shows attendee details with check-in/check-out button
 */
export const checkinAdminPage = (
  entries: TokenEntry[],
  checkinPath: string,
  message: string | null,
  allowedDomain: string,
): string => {
  const showDate = entries.some((e) => e.attendee.date !== null);
  const tableRows: AttendeeTableRow[] = pipe(
    map((e: TokenEntry): AttendeeTableRow => ({
      attendee: e.attendee,
      eventId: e.event.id,
      eventName: e.event.name,
      hasPaidEvent: e.event.unit_price !== null,
    })),
  )(entries);

  const allCheckedIn = entries.every((e) => e.attendee.checked_in === "true");
  const buttonLabel = allCheckedIn ? "Check Out All" : "Check In All";
  const buttonClass = allCheckedIn ? "bulk-checkout" : "bulk-checkin";
  const nextValue = allCheckedIn ? "false" : "true";

  return String(
    <Layout title="Check-in">
      <h1>Check-in</h1>
      {message && <p class="success">{message}</p>}
      <CsrfForm action={checkinPath}>
        <input type="hidden" name="check_in" value={nextValue} />
        <button type="submit" class={buttonClass}>{buttonLabel}</button>
      </CsrfForm>
      <div class="table-scroll">
        <Raw html={AttendeeTable({
          rows: tableRows,
          allowedDomain,
          showEvent: true,
          showDate,
          returnUrl: checkinPath,
        })} />
      </div>
    </Layout>
  );
};

/**
 * Non-admin check-in page - simple message telling the user to show this to an admin
 */
export const checkinPublicPage = (): string =>
  String(
    <Layout title="Check-in">
      <h1>Check-in</h1>
      <p>Please show this QR code to an event administrator to check in.</p>
    </Layout>
  );
