/**
 * Ticket view page template - displays attendee ticket information with QR code
 */

import { map, pipe } from "#fp";
import { formatDateLabel } from "#lib/dates.ts";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { TokenEntry } from "#routes/token-utils.ts";
import { escapeHtml, Layout } from "#templates/layout.tsx";

/** Re-export for backwards compatibility */
export type { TokenEntry as TicketEntry };

/** Format a date cell value: formatted label or empty string */
const formatDateCol = (date: string | null): string =>
  date ? formatDateLabel(date) : "";

/**
 * Ticket view page - shows event name + quantity per ticket, with inline QR code
 * The QR code encodes the /checkin/... URL for admin scanning
 */
export const ticketViewPage = (entries: TokenEntry[], qrSvg: string): string => {
  const showDate = entries.some((e) => e.attendee.date !== null);
  const rows = pipe(
    map(({ event, attendee }: TokenEntry) => {
      const dateCol = showDate ? `<td>${formatDateCol(attendee.date)}</td>` : "";
      return `<tr><td>${escapeHtml(event.name)}</td>${dateCol}<td>${attendee.quantity}</td></tr>`;
    }),
    (r: string[]) => r.join(""),
  )(entries);

  return String(
    <Layout title="Your Tickets">
      <h1>Your Tickets</h1>
      <div class="text-center">
        <Raw html={qrSvg} />
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Event</th>
              {showDate && <th>Date</th>}
              <th>Quantity</th>
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
