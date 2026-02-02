/**
 * Check-in page templates
 * Admin view: attendee details with check-in/check-out button
 * Non-admin view: simple confirmation message
 */

import { map, pipe } from "#fp";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { TokenEntry } from "#routes/token-utils.ts";
import { Layout } from "#templates/layout.tsx";

/** Re-export for backwards compatibility */
export type { TokenEntry as CheckinEntry };

/** Render a single attendee detail row (admin view) */
const renderCheckinRow = ({ event, attendee }: TokenEntry): string => {
  const isCheckedIn = attendee.checked_in === "true";
  return String(
    <tr>
      <td><a href={`/admin/event/${event.id}`}>{event.name}</a></td>
      <td>{attendee.name}</td>
      <td>{attendee.email || ""}</td>
      <td>{attendee.phone || ""}</td>
      <td>{attendee.quantity}</td>
      <td>{isCheckedIn ? "Yes" : "No"}</td>
    </tr>,
  );
};

/**
 * Admin check-in page - shows attendee details with check-in/check-out button
 */
export const checkinAdminPage = (
  entries: TokenEntry[],
  csrfToken: string,
  checkinPath: string,
  message: string | null,
): string => {
  const rows = pipe(
    map((e: TokenEntry) => renderCheckinRow(e)),
    (r: string[]) => r.join(""),
  )(entries);

  const allCheckedIn = entries.every((e) => e.attendee.checked_in === "true");
  const buttonLabel = allCheckedIn ? "Check Out All" : "Check In All";
  const buttonClass = allCheckedIn ? "bulk-checkout" : "bulk-checkin";
  const nextValue = allCheckedIn ? "false" : "true";

  return String(
    <Layout title="Check-in">
      <h1>Check-in</h1>
      {message && <p class="success">{message}</p>}
      <form method="POST" action={checkinPath}>
        <input type="hidden" name="csrf_token" value={csrfToken} />
        <input type="hidden" name="check_in" value={nextValue} />
        <button type="submit" class={buttonClass}>{buttonLabel}</button>
      </form>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Quantity</th>
              <th>Checked In</th>
            </tr>
          </thead>
          <tbody>
            <Raw html={rows} />
          </tbody>
        </table>
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
