/**
 * Ticket view page template - displays attendee ticket information with QR code
 */

import { map, pipe } from "#fp";
import { getTz } from "#lib/config.ts";
import { formatCurrency } from "#lib/currency.ts";
import { formatDateLabel, formatDatetimeLabel } from "#lib/dates.ts";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import type { TokenEntry } from "#routes/token-utils.ts";
import { escapeHtml, Layout } from "#templates/layout.tsx";
import { renderEventImage } from "#templates/public.tsx";

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

  const imageHtml = renderEventImage(event, "ticket-card-image");

  const eventDateHtml = event.date
    ? `<div class="ticket-card-date">${escapeHtml(formatDatetimeLabel(event.date, tz))}</div>`
    : "";

  const locationHtml = event.location
    ? `<div class="ticket-card-location">${escapeHtml(event.location)}</div>`
    : "";

  const descriptionHtml = event.description
    ? `<div class="ticket-card-description">${escapeHtml(event.description)}</div>`
    : "";

  const attendeeDateHtml = attendee.date
    ? `<div class="ticket-card-date">Booking Date: ${escapeHtml(formatDateLabel(attendee.date))}</div>`
    : "";

  const pricePaid = Number(attendee.price_paid);
  const priceHtml = pricePaid > 0
    ? `<div class="ticket-card-price">Price: ${escapeHtml(formatCurrency(pricePaid))}</div>`
    : "";

  return `
    <div class="ticket-card">
      ${imageHtml}
      <div class="ticket-card-name">${escapeHtml(event.name)}</div>
      ${eventDateHtml}
      ${locationHtml}
      ${descriptionHtml}
      ${attendeeDateHtml}
      <div class="ticket-card-quantity">Quantity: ${attendee.quantity}</div>
      ${priceHtml}
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
