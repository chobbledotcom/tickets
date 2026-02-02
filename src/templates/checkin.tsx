/**
 * Check-in page templates
 * Admin view: attendee details with checked-in status and check-out button
 * Non-admin view: simple confirmation message
 */

import { map, pipe } from "#fp";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { TokenEntry } from "#routes/token-utils.ts";
import { Layout } from "#templates/layout.tsx";

/** Re-export for backwards compatibility */
export type { TokenEntry as CheckinEntry };

/** Render a single attendee detail row (admin view) */
const renderCheckinRow = ({ event, attendee }: TokenEntry): string =>
  `<tr><td>${event.name}</td><td>${attendee.quantity}</td><td>${attendee.checked_in === "true" ? "Yes" : "No"}</td></tr>`;

/**
 * Admin check-in page - shows attendee details with check-out option
 */
export const checkinAdminPage = (
  entries: TokenEntry[],
  csrfToken: string,
  checkinPath: string,
): string => {
  const rows = pipe(
    map(renderCheckinRow),
    (r: string[]) => r.join(""),
  )(entries);

  return String(
    <Layout title="Check-in">
      <h1>Check-in Complete</h1>
      <table>
        <thead>
          <tr>
            <th>Event</th>
            <th>Quantity</th>
            <th>Checked In</th>
          </tr>
        </thead>
        <tbody>
          <Raw html={rows} />
        </tbody>
      </table>
      <form method="POST" action={checkinPath}>
        <input type="hidden" name="csrf_token" value={csrfToken} />
        <button type="submit">Check Out</button>
      </form>
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
