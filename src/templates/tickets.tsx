/**
 * Ticket view page template - displays attendee ticket information with QR code
 */

import { map, pipe } from "#fp";
import { formatDateLabel, formatDatetimeLabel } from "#lib/dates.ts";
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
  const showEventDate = entries.some((e) => e.event.date !== "");
  const showLocation = entries.some((e) => e.event.location !== "");
  const rows = pipe(
    map(({ event, attendee }: TokenEntry) => {
      const dateCol = showDate ? `<td>${formatDateCol(attendee.date)}</td>` : "";
      const eventDateCol = showEventDate ? `<td>${escapeHtml(event.date ? formatDatetimeLabel(event.date) : "")}</td>` : "";
      const locationCol = showLocation ? `<td>${escapeHtml(event.location)}</td>` : "";
      return `<tr><td>${escapeHtml(event.name)}</td>${eventDateCol}${locationCol}${dateCol}<td>${attendee.quantity}</td></tr>`;
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
              {showEventDate && <th>Event Date</th>}
              {showLocation && <th>Location</th>}
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
