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
const renderCheckinRow = (
  { event, attendee }: TokenEntry,
  csrfToken: string,
  checkinPath: string,
): string => {
  const isCheckedIn = attendee.checked_in === "true";
  const buttonLabel = isCheckedIn ? "Check out" : "Check in";
  const buttonClass = isCheckedIn ? "checkout" : "checkin";
  const nextValue = isCheckedIn ? "false" : "true";
  return String(
    <tr>
      <td>{event.name}</td>
      <td>{attendee.name}</td>
      <td>{attendee.email || ""}</td>
      <td>{attendee.phone || ""}</td>
      <td>{attendee.quantity}</td>
      <td>{isCheckedIn ? "Yes" : "No"}</td>
      <td>
        <form method="POST" action={checkinPath} class="checkin-form">
          <input type="hidden" name="csrf_token" value={csrfToken} />
          <input type="hidden" name="check_in" value={nextValue} />
          <button type="submit" class={buttonClass}>{buttonLabel}</button>
        </form>
      </td>
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
    map((e: TokenEntry) => renderCheckinRow(e, csrfToken, checkinPath)),
    (r: string[]) => r.join(""),
  )(entries);

  return String(
    <Layout title="Check-in">
      <h1>Check-in</h1>
      {message && <p class="success">{message}</p>}
      <table>
        <thead>
          <tr>
            <th>Event</th>
            <th>Name</th>
            <th>Email</th>
            <th>Phone</th>
            <th>Quantity</th>
            <th>Checked In</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <Raw html={rows} />
        </tbody>
      </table>
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
