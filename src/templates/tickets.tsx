/**
 * Ticket view page template - displays attendee ticket information with QR code
 */

import { map, pipe } from "#fp";
import { getTz } from "#lib/config.ts";
import { formatDateLabel, formatDatetimeLabel } from "#lib/dates.ts";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { TokenEntry } from "#routes/token-utils.ts";
import { escapeHtml, Layout } from "#templates/layout.tsx";

/** Re-export for backwards compatibility */
export type { TokenEntry as TicketEntry };

/** Ticket card with individual QR code */
export type TicketCard = {
  entry: TokenEntry;
  qrSvg: string;
};

/** Pluralize ticket count */
const ticketCount = (count: number): string =>
  count === 1 ? "1 Ticket" : `${count} Tickets`;

/** Render a single ticket card */
const renderTicketCard = ({ entry, qrSvg }: TicketCard): string => {
  const { event, attendee } = entry;
  const tz = getTz();

  const eventDateHtml = event.date
    ? `<div class="ticket-card-date">${escapeHtml(formatDatetimeLabel(event.date, tz))}</div>`
    : "";

  const locationHtml = event.location
    ? `<div class="ticket-card-location">${escapeHtml(event.location)}</div>`
    : "";

  const attendeeDateHtml = attendee.date
    ? `<div class="ticket-card-date">Booking Date: ${escapeHtml(formatDateLabel(attendee.date))}</div>`
    : "";

  const quantityHtml = attendee.quantity > 1
    ? `<div class="ticket-card-quantity">Quantity: ${attendee.quantity}</div>`
    : "";

  return `
    <div class="ticket-card">
      <div class="ticket-card-name">${escapeHtml(event.name)}</div>
      ${eventDateHtml}
      ${locationHtml}
      ${attendeeDateHtml}
      ${quantityHtml}
      <div class="ticket-card-qr">${qrSvg}</div>
    </div>
  `;
};

/**
 * Ticket view page - shows individual cards for each ticket with its own QR code
 * The QR code encodes the /checkin/:token URL for admin scanning
 */
export const ticketViewPage = (cards: TicketCard[]): string => {
  const cardHtml = pipe(
    map(renderTicketCard),
    (c: string[]) => c.join(""),
  )(cards);

  return String(
    <Layout title="Your Tickets">
      <h1>{ticketCount(cards.length)}</h1>
      <div class="ticket-slider">
        <Raw html={cardHtml} />
      </div>
    </Layout>
  );
};
