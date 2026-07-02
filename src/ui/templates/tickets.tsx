/**
 * Ticket view page template - displays attendee ticket information with QR code
 */

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
 * then the shared QR. The attendee's member lines share one token, so the
 * package is a single card. Wallet (Apple/Google) links are deliberately
 * omitted: both wallet routes resolve a token to a single member listing, so a
 * saved pass would show only the first member (and leak a hidden member's name)
 * rather than the package the buyer clicked. */
const renderPackageCard = (
  cards: TicketCard[],
  packageInfo: PackageDisplay,
): string => {
  const { token } = cards[0]!;
  const purchaseOnly = cards.every((c) => c.entry.listing.purchase_only);
  // Each member's signed attachment link rides along on its row so a bundle
  // buyer can still download per-listing files (a standalone card would show
  // them). A hidden package shows no members, so its attachments stay concealed
  // too — its whole premise is that buyers never see the member listings.
  const memberAttachment = (c: TicketCard): string =>
    optionalHtml(
      c.attachmentUrl,
      (url) =>
        ` <a href="${escapeHtml(url)}" class="attachment-link">${t("tickets.download")} ${escapeHtml(
          c.entry.listing.attachment_name,
        )}</a>`,
    );
  // A hidden package shows no member rows, but must still tell the buyer how many
  // they bought — otherwise a multi-quantity purchase renders only the package
  // name + QR. Show the package's total booked quantity (summed across members,
  // matching the collapsed email row) without naming any member.
  const membersHtml = packageInfo.hideListings
    ? `<div class="ticket-card-package-qty"><span class="package-member-qty">&times;${cards.reduce(
        (total, c) => total + c.entry.attendee.quantity,
        0,
      )}</span></div>`
    : `<ul class="ticket-card-package-members">${cards
        .map(
          (c) =>
            `<li>${escapeHtml(c.entry.listing.name)} <span class="package-member-qty">&times;${c.entry.attendee.quantity}</span>${memberAttachment(c)}</li>`,
        )
        .join("")}</ul>`;
  // The package card replaces the per-member cards, so it must carry the same
  // "ID required" warning renderTicketCard shows — otherwise a package buyer is
  // never told a member is non-transferable, yet the scanner still enforces it.
  // Kept package-level (it never names a member) so a hidden package stays
  // concealed; purchase-only members aren't checked in, so they don't trigger it.
  const nonTransferableHtml = cards.some(
    (c) => c.entry.listing.non_transferable && !c.entry.listing.purchase_only,
  )
    ? `<div class="ticket-card-notice">${t("tickets.non_transferable")}</div>`
    : "";
  // A dated package (daily/customisable members share one start date) shows the
  // booked date like a standalone card would. The bundle's members can carry
  // different fixed durations, so the widest member's range covers the whole
  // stay. Package-level (no member named), so a hidden package stays concealed.
  const widestDated = cards
    .filter((c) => c.entry.attendee.date)
    .reduce(
      (widest: TicketCard | null, c) =>
        !widest ||
        normalizeDurationDays(c.entry.listing.duration_days) >
          normalizeDurationDays(widest.entry.listing.duration_days)
          ? c
          : widest,
      null,
    );
  const dateHtml = widestDated
    ? `<div class="ticket-card-date">${t("tickets.booking_date")} ${escapeHtml(
        computeBookingDateLabel(
          widestDated.entry.attendee.date,
          widestDated.entry.listing,
        ),
      )}</div>`
    : "";
  return `
    <div class="ticket-card">
      <div class="ticket-card-name">${escapeHtml(packageInfo.name)}</div>
      ${dateHtml}
      ${membersHtml}
      ${nonTransferableHtml}
      ${renderQrBlock(token, purchaseOnly)}
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
/** Group key for collapsing a package booking into one card: rows sharing a
 * token AND a (real) package id are one card. Keying on the token too keeps two
 * attendees who share a package (`/t/a+b`) as separate cards — each with its own
 * check-in QR — rather than merging them and dropping a token. */
const packageCardKey = (card: TicketCard): string =>
  `${card.token} ${card.entry.attendee.package_group_id}`;

/** Package rows bucketed by (token, package) for one-card-per-bucket rendering,
 * plus the set of tokens carrying any package booking. The direct wallet
 * endpoints 404 any token whose entries include a package row
 * (lookupSingleTokenPassData), so a standalone card merged under such a token
 * must not advertise wallet links it can't honour — hence `packageTokens`. */
const collectPackageBuckets = (
  cards: TicketCard[],
  displayFor: (card: TicketCard) => PackageDisplay | undefined,
): { buckets: Map<string, TicketCard[]>; packageTokens: Set<string> } => {
  const buckets = new Map<string, TicketCard[]>();
  const packageTokens = new Set<string>();
  for (const card of cards) {
    if (!displayFor(card)) continue;
    packageTokens.add(card.token);
    const key = packageCardKey(card);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(card);
    else buckets.set(key, [card]);
  }
  return { buckets, packageTokens };
};

/** Render each card to HTML: a package row collapses into one package card per
 * bucket (rendered once); any other row is a normal card — with wallet links
 * suppressed when its token also carries a package (the pass would 404). */
const renderCardsHtml = (
  cards: TicketCard[],
  displayFor: (card: TicketCard) => PackageDisplay | undefined,
  buckets: Map<string, TicketCard[]>,
  packageTokens: Set<string>,
  appleWalletEnabled: boolean,
  googleWalletEnabled: boolean,
): string[] => {
  const rendered = new Set<string>();
  const htmlParts: string[] = [];
  for (const card of cards) {
    const display = displayFor(card);
    if (display) {
      const key = packageCardKey(card);
      if (rendered.has(key)) continue;
      rendered.add(key);
      htmlParts.push(renderPackageCard(buckets.get(key)!, display));
    } else {
      const tokenHasPackage = packageTokens.has(card.token);
      htmlParts.push(
        renderTicketCard(
          card,
          appleWalletEnabled && !tokenHasPackage,
          googleWalletEnabled && !tokenHasPackage,
        ),
      );
    }
  }
  return htmlParts;
};

export const ticketViewPage = (
  cards: TicketCard[],
  appleWalletEnabled = false,
  googleWalletEnabled = false,
  packageDisplays: ReadonlyMap<number, PackageDisplay> = new Map(),
): string => {
  // Resolve each card's package display (only for a real, non-zero package id),
  // then bucket the package rows and render. A row with no display renders as its
  // own normal card — so a token mixing a hidden package with a standalone
  // booking collapses the package (hiding its members) while still showing the
  // standalone ticket.
  const displayFor = (card: TicketCard): PackageDisplay | undefined =>
    packageDisplays.get(card.entry.attendee.package_group_id);
  const { buckets, packageTokens } = collectPackageBuckets(cards, displayFor);
  const htmlParts = renderCardsHtml(
    cards,
    displayFor,
    buckets,
    packageTokens,
    appleWalletEnabled,
    googleWalletEnabled,
  );
  const cardHtml = htmlParts.join("");

  const allPurchaseOnly = cards.every((c) => c.entry.listing.purchase_only);
  // Each package collapses to one card, so count rendered cards (not member rows)
  // in the heading rather than revealing a package's member count.
  const heading = allPurchaseOnly
    ? "Your Purchase"
    : ticketCount(htmlParts.length);
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
