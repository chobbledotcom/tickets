/**
 * Ticket view page template - displays attendee ticket information with QR code
 */

import { formatDateLabel } from "#lib/dates.ts";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { TokenEntry } from "#routes/token-utils.ts";
import { escapeHtml, Layout } from "#templates/layout.tsx";

/** Re-export for backwards compatibility */
export type { TokenEntry as TicketEntry };

/**
 * Ticket view page - shows event name + quantity per ticket, with inline QR code
 * The QR code encodes the /checkin/... URL for admin scanning
 */
export const ticketViewPage = (entries: TokenEntry[], qrSvg: string): string => {
  const showDate = entries.some((e) => e.attendee.date !== null);
  let rows = "";
  for (const { event, attendee } of entries) {
    const dateCol = showDate ? `<td>${attendee.date ? formatDateLabel(attendee.date) : ""}</td>` : "";
    rows += `<tr><td>${escapeHtml(event.name)}</td>${dateCol}<td>${attendee.quantity}</td></tr>`;
  }

  return String(
    <Layout title="Your Tickets">
      <h1>Your Tickets</h1>
      <div style="text-align:center;margin:1em 0">
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
