/**
 * Ticket view page template - displays attendee ticket information with QR code
 */

import { map, pipe } from "#fp";
import { formatCurrency } from "#lib/currency.ts";
import { formatDateLabel, formatDatetimeLabel } from "#lib/dates.ts";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { renderMarkdown } from "#lib/markdown.ts";
import type { TokenEntry } from "#routes/token-utils.ts";
import { escapeHtml, Layout } from "#templates/layout.tsx";
import { renderEventImage } from "#templates/public.tsx";

/** Re-export for backwards compatibility */
export type { TokenEntry as TicketEntry };

/** Ticket card data for rendering */
export type TicketCard = {
  entry: TokenEntry;
  token: string;
  attachmentUrl?: string;
};

/** Pluralize ticket count */
const ticketCount = (count: number): string =>
  count === 1 ? "1 Ticket" : `${count} Tickets`;

/** Render an "Apple Wallet" link for a token (.pkpass extension aids iOS detection) */
const renderAppleWalletLink = (token: string): string =>
  `<a href="/wallet/${escapeHtml(token)}.pkpass" class="wallet-link">Apple Wallet</a>`;

/** Render a "Google Wallet" link for a token */
const renderGoogleWalletLink = (token: string): string =>
  `<a href="/gwallet/${escapeHtml(token)}" class="wallet-link">Google Wallet</a>`;

/** Render a single ticket card */
const renderTicketCard = (
  card: TicketCard,
  appleWalletEnabled: boolean,
  googleWalletEnabled: boolean,
): string => {
  const { entry, token, attachmentUrl } = card;
  const { event, attendee } = entry;
  const imageHtml = renderEventImage(event, "ticket-card-image");
  const eventDateHtml = event.date
    ? `<div class="ticket-card-date">${escapeHtml(formatDatetimeLabel(event.date))}</div>`
    : "";

  const locationHtml = event.location
    ? `<div class="ticket-card-location">${escapeHtml(event.location)}</div>`
    : "";

  const descriptionHtml = event.description
    ? `<div class="ticket-card-description">${renderMarkdown(event.description)}</div>`
    : "";

  const attendeeDateHtml = attendee.date
    ? `<div class="ticket-card-date">Booking Date: ${escapeHtml(formatDateLabel(attendee.date))}</div>`
    : "";

  const pricePaid = Number(attendee.price_paid);
  const priceHtml =
    pricePaid > 0
      ? `<div class="ticket-card-price">Price: ${escapeHtml(formatCurrency(pricePaid))}</div>`
      : "";

  const nonTransferableHtml =
    event.non_transferable && !event.purchase_only
      ? `<div class="ticket-card-notice">Non-transferable &mdash; ID required at entry</div>`
      : "";

  const walletLinks = event.purchase_only
    ? ""
    : [
        appleWalletEnabled ? renderAppleWalletLink(token) : "",
        googleWalletEnabled ? renderGoogleWalletLink(token) : "",
      ]
        .filter(Boolean)
        .join(" / ");
  const walletHtml = walletLinks
    ? `<div class="ticket-card-wallet">Add to: ${walletLinks}</div>`
    : "";

  const attachmentHtml = attachmentUrl
    ? `<a href="${escapeHtml(attachmentUrl)}" class="attachment-link">Download: ${escapeHtml(event.attachment_name)}</a>`
    : "";

  return `
    <div class="ticket-card">
      ${imageHtml}
      <div class="ticket-card-name">${escapeHtml(event.name)}</div>
      ${eventDateHtml}
      ${locationHtml}
      ${descriptionHtml}
      ${nonTransferableHtml}
      ${attendeeDateHtml}
      <div class="ticket-card-quantity">Quantity: ${attendee.quantity}</div>
      ${priceHtml}
      ${attachmentHtml}
      ${
        event.purchase_only
          ? ""
          : `<div class="ticket-card-qr"><img src="/t/${escapeHtml(token)}/svg" alt="QR code" /></div>
      <div class="ticket-card-token">${escapeHtml(token)}</div>`
      }
      ${walletHtml}
    </div>
  `;
};

/**
 * Ticket view page - shows individual cards for each ticket with its own QR code
 * The QR code encodes the /checkin/:token URL for admin scanning
 */
export const ticketViewPage = (
  cards: TicketCard[],
  appleWalletEnabled = false,
  googleWalletEnabled = false,
): string => {
  const cardHtml = pipe(
    map((card: TicketCard) =>
      renderTicketCard(card, appleWalletEnabled, googleWalletEnabled),
    ),
    (c: string[]) => c.join(""),
  )(cards);

  const allPurchaseOnly = cards.every((c) => c.entry.event.purchase_only);
  const heading = allPurchaseOnly ? "Your Purchase" : ticketCount(cards.length);
  const title = allPurchaseOnly ? "Your Purchase" : "Your Tickets";

  return String(
    <Layout title={title}>
      <h1>{heading}</h1>
      <div class="ticket-slider">
        <Raw html={cardHtml} />
      </div>
    </Layout>,
  );
};
