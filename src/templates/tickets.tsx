/**
 * Ticket view page template - displays attendee ticket information with QR code
 */

import { map, pipe } from "#fp";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { TokenEntry } from "#routes/token-utils.ts";
import { escapeHtml, Layout } from "#templates/layout.tsx";

/** Re-export for backwards compatibility */
export type { TokenEntry as TicketEntry };

/** Render a single ticket row */
const renderTicketRow = ({ event, attendee }: TokenEntry): string =>
  `<tr><td>${escapeHtml(event.name)}</td><td>${attendee.quantity}</td></tr>`;

/**
 * Ticket view page - shows event name + quantity per ticket, with inline QR code
 * The QR code encodes the /checkin/... URL for admin scanning
 */
export const ticketViewPage = (entries: TokenEntry[], qrSvg: string): string => {
  const rows = pipe(
    map(renderTicketRow),
    (r: string[]) => r.join(""),
  )(entries);

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
