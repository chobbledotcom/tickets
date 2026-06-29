/**
 * Ticket view page template - displays attendee ticket information with QR code
 */

import { map, pipe } from "#fp";
import { t } from "#i18n";
import type { TokenEntry } from "#routes/tickets/token-utils.ts";
import { formatCurrency } from "#shared/currency.ts";
import {
  addDays,
  formatDateLabel,
  formatDateRangeLabelCompactEn,
  formatDatetimeLabel,
} from "#shared/dates.ts";
import type { PackageDisplay } from "#shared/db/groups.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import { normalizeDurationDays } from "#shared/types.ts";
import { escapeHtml, Layout } from "#templates/layout.tsx";
import { renderListingImage } from "#templates/public.tsx";

/** Alias export used by ticket templates */
export type { TokenEntry as TicketEntry };

/** Ticket card data for rendering */
export type TicketCard = {
  entry: TokenEntry;
  token: string;
  attachmentUrl?: string;
};

/** Pluralize ticket count */
const ticketCount = (count: number): string => t("tickets.count", { count });

/** Render an "Apple Wallet" link for a token (.pkpass extension aids iOS detection) */
const renderAppleWalletLink = (token: string): string =>
  `<a href="/wallet/${escapeHtml(
    token,
  )}.pkpass" class="wallet-link">${t("tickets.apple_wallet")}</a>`;

/** Render a "Google Wallet" link for a token */
const renderGoogleWalletLink = (token: string): string =>
  `<a href="/gwallet/${escapeHtml(
    token,
  )}" class="wallet-link">${t("tickets.google_wallet")}</a>`;

/** Render `render(value)` when `value` is truthy, else "". Replaces the
 * `value ? `<div>${render(value)}`</div>` : ""` pattern that dominates the
 * ticket-card template and was the main complexity driver. */
const optionalHtml = <T,>(
  value: T | null | undefined | "" | 0 | false,
  render: (v: T) => string,
): string => (value ? render(value) : "");

/** Compute the "Booking Date" label for the attendee, expanding multi-day
 * daily bookings into a compact date range. "" when the attendee has no date. */
const computeBookingDateLabel = (
  attendeeDate: string | null,
  listing: TokenEntry["listing"],
): string => {
  if (!attendeeDate) return "";
  // A booking date only ever exists for daily listings, so the listing's
  // duration drives whether the label is a single day or a compact range.
  const durationDays = normalizeDurationDays(listing.duration_days);
  return durationDays > 1
    ? formatDateRangeLabelCompactEn(
        attendeeDate,
        addDays(attendeeDate, durationDays - 1),
      )
    : formatDateLabel(attendeeDate);
};

/** Render the "Add to: …" wallet links section, or "" when purchase-only or no
 * wallet provider is enabled. */
const renderWalletSection = (
  token: string,
  purchaseOnly: boolean,
  appleWalletEnabled: boolean,
  googleWalletEnabled: boolean,
): string => {
  if (purchaseOnly) return "";
  const links = [
    appleWalletEnabled ? renderAppleWalletLink(token) : "",
    googleWalletEnabled ? renderGoogleWalletLink(token) : "",
  ]
    .filter(Boolean)
    .join(" / ");
  return links
    ? `<div class="ticket-card-wallet">${t("tickets.add_to")} ${links}</div>`
    : "";
};

/** The shared QR + token block (empty for purchase-only listings, which aren't
 * checked in). One attendee's lines all share its token, so a package renders it
 * once on the package card. */
const renderQrBlock = (token: string, purchaseOnly: boolean): string =>
  purchaseOnly
    ? ""
    : `<div class="ticket-card-qr"><img src="/t/${escapeHtml(
        token,
      )}/svg" alt={t("listing_qr.qr_code")} /></div>
      <div class="ticket-card-token">${escapeHtml(token)}</div>`;

/** Render one card for a whole package booking: the package name, then each
 * member with its booked quantity (omitted when the package hides its listings),
 * then the shared QR/wallet. The attendee's member lines share one token, so the
 * package is a single card. */
const renderPackageCard = (
  cards: TicketCard[],
  packageInfo: PackageDisplay,
  appleWalletEnabled: boolean,
  googleWalletEnabled: boolean,
): string => {
  const { token } = cards[0]!;
  const purchaseOnly = cards.every((c) => c.entry.listing.purchase_only);
  const membersHtml = packageInfo.hideListings
    ? ""
    : `<ul class="ticket-card-package-members">${cards
        .map(
          (c) =>
            `<li>${escapeHtml(c.entry.listing.name)} <span class="package-member-qty">&times;${c.entry.attendee.quantity}</span></li>`,
        )
        .join("")}</ul>`;
  return `
    <div class="ticket-card">
      <div class="ticket-card-name">${escapeHtml(packageInfo.name)}</div>
      ${membersHtml}
      ${renderQrBlock(token, purchaseOnly)}
      ${renderWalletSection(token, purchaseOnly, appleWalletEnabled, googleWalletEnabled)}
    </div>
  `;
};

/** Render a single ticket card */
const renderTicketCard = (
  card: TicketCard,
  appleWalletEnabled: boolean,
  googleWalletEnabled: boolean,
): string => {
  const { entry, token, attachmentUrl } = card;
  const { listing, attendee } = entry;
  const imageHtml = renderListingImage(listing, "ticket-card-image");
  const listingDateHtml = optionalHtml(
    listing.date,
    (d) =>
      `<div class="ticket-card-date">${escapeHtml(formatDatetimeLabel(d))}</div>`,
  );
  const locationHtml = optionalHtml(
    listing.location,
    (l) => `<div class="ticket-card-location">${escapeHtml(l)}</div>`,
  );
  const descriptionHtml = optionalHtml(
    listing.description,
    (d) => `<div class="ticket-card-description">${renderMarkdown(d)}</div>`,
  );

  const bookingDateLabel = computeBookingDateLabel(attendee.date, listing);
  const attendeeDateHtml = optionalHtml(
    bookingDateLabel,
    (label) =>
      `<div class="ticket-card-date">${t("tickets.booking_date")} ${escapeHtml(label)}</div>`,
  );

  const pricePaid = Number(attendee.price_paid);
  const priceHtml = optionalHtml(
    pricePaid,
    (p) =>
      `<div class="ticket-card-price">${t("tickets.price")} ${escapeHtml(formatCurrency(p))}</div>`,
  );

  const nonTransferableHtml =
    listing.non_transferable && !listing.purchase_only
      ? `<div class="ticket-card-notice">${t("tickets.non_transferable")}</div>`
      : "";

  const walletHtml = renderWalletSection(
    token,
    listing.purchase_only,
    appleWalletEnabled,
    googleWalletEnabled,
  );

  const attachmentHtml = optionalHtml(
    attachmentUrl,
    (url) =>
      `<a href="${escapeHtml(url)}" class="attachment-link">${t("tickets.download")} ${escapeHtml(
        listing.attachment_name,
      )}</a>`,
  );

  return `
    <div class="ticket-card">
      ${imageHtml}
      <div class="ticket-card-name">${escapeHtml(listing.name)}</div>
      ${listingDateHtml}
      ${locationHtml}
      ${descriptionHtml}
      ${nonTransferableHtml}
      ${attendeeDateHtml}
      <div class="ticket-card-quantity">${t("tickets.quantity")} ${attendee.quantity}</div>
      ${priceHtml}
      ${attachmentHtml}
      ${renderQrBlock(token, listing.purchase_only)}
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
  packageInfo: PackageDisplay | null = null,
): string => {
  const cardHtml = packageInfo
    ? renderPackageCard(
        cards,
        packageInfo,
        appleWalletEnabled,
        googleWalletEnabled,
      )
    : pipe(
        map((card: TicketCard) =>
          renderTicketCard(card, appleWalletEnabled, googleWalletEnabled),
        ),
        (c) => c.join(""),
      )(cards);

  const allPurchaseOnly = cards.every((c) => c.entry.listing.purchase_only);
  // A package is one card, so don't reveal the member count in the heading.
  const heading = allPurchaseOnly
    ? "Your Purchase"
    : ticketCount(packageInfo ? 1 : cards.length);
  const title = allPurchaseOnly ? "Your Purchase" : t("tickets.title");

  return String(
    <Layout title={title}>
      <h1>{heading}</h1>
      <div class="ticket-slider">
        <Raw html={cardHtml} />
      </div>
    </Layout>,
  );
};
