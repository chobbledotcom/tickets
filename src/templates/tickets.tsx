/**
 * Ticket view page template - displays attendee ticket information
 */

import { map, pipe } from "#fp";
import type { Attendee, EventWithCount } from "#lib/types.ts";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { Layout } from "#templates/layout.tsx";

/** Ticket entry: attendee paired with their event */
export type TicketEntry = {
  attendee: Attendee;
  event: EventWithCount;
};

/** Render a single ticket row */
const renderTicketRow = ({ event, attendee }: TicketEntry): string =>
  `<tr><td>${event.name}</td><td>${attendee.quantity}</td></tr>`;

/**
 * Ticket view page - shows event name and quantity per ticket
 */
export const ticketViewPage = (entries: TicketEntry[]): string => {
  const rows = pipe(
    map(renderTicketRow),
    (r: string[]) => r.join(""),
  )(entries);

  return String(
    <Layout title="Your Tickets">
      <h1>Your Tickets</h1>
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
    </Layout>
  );
};
