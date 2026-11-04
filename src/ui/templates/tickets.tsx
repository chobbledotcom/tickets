/**
 * Ticket view page template - displays attendee ticket information with QR code
 */

/* jscpd:ignore-start -- imports */
import type { PackageDisplay } from "#db/groups.ts";
import { sumOf } from "#fp";
import { t } from "#i18n";
import { escapeHtml } from "#jsx/escape-html.ts";
import { Raw } from "#jsx/jsx-runtime.ts";
import type { ModifierLine } from "#routes/tickets/modifier-shares.ts";
import type { TokenEntry } from "#routes/tickets/token-utils.ts";
import { formatCurrency, formatSignedCurrency } from "#shared/currency.ts";
import { bookedRangeLabel } from "#shared/date-labels.ts";
import { formatDatetimeLabel, widestDatedEntry } from "#shared/dates.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import { headingLayoutPage } from "#templates/components/heading-layout.tsx";
import { renderListingImage } from "#templates/public/shared.tsx";
import { clampDurationDays } from "#types";
/* jscpd:ignore-end */

/** Ticket card data for rendering */
export type TicketCard = {
  entry: TokenEntry;
  token: string;
  attachmentUrl?: string;
  /** The card's share of its order's modifiers. Absent when none changed the
   *  order's price. */
  modifiers?: readonly ModifierLine[];
};

/** True when every card is a purchase-only listing (no admission ticket). */
const allCardsPurchaseOnly = (cards: readonly TicketCard[]): boolean =>
  cards.every((c) => c.entry.listing.purchase_only);

/** Pluralize ticket count */
const ticketCount = (count: number): string => t("tickets.count", { count });

/** Render a wallet link: `<a href="/prefix/${token}[suffix]" class="wallet-link">label</a>` */
const walletLink =
  (
    prefix: string,
    labelKey: string,
    suffix = "",
  ): ((token: string) => string) =>
  (token: string) =>
    `<a href="/${prefix}/${escapeHtml(token)}${suffix}" class="wallet-link">${t(
      labelKey,
    )}</a>`;

/** Render an "Apple Wallet" link for a token (.pkpass extension aids iOS detection) */
const renderAppleWalletLink = walletLink(
  "wallet",
  "tickets.apple_wallet",
  ".pkpass",
);

/** Render a "Google Wallet" link for a token */
const renderGoogleWalletLink = walletLink("gwallet", "tickets.google_wallet");

/** Render `render(value)` when `value` is truthy, else "". Replaces the
 * `value ? `<div>${render(value)}`</div>` : ""` pattern that dominates the
 * ticket-card template and was the main complexity driver. */
const optionalHtml = <T,>(
  value: T | null | undefined | "" | 0 | false,
  render: (v: T) => string,
): string => (value ? render(value) : "");

/** One row per modifier that changed this card's price, with its signed amount,
 *  then the total those rows reach. The card shows neither when no modifier
 *  changed the price. */
const renderModifiers = (
  modifiers: readonly ModifierLine[],
  pricePaid: number,
): string => {
  if (modifiers.length === 0) return "";
  const rows = modifiers.map(
    (modifier) =>
      `<li>${escapeHtml(modifier.name)} <span class="ticket-card-modifier-amount">${escapeHtml(formatSignedCurrency(modifier.amount))}</span></li>`,
  );
  const total = pricePaid + sumOf((m: ModifierLine) => m.amount)(modifiers);
  return (
    `<ul class="ticket-card-modifiers">${rows.join("")}</ul>` +
    `<div class="ticket-card-total"><strong>${t("tickets.total")}</strong> ${escapeHtml(formatCurrency(total))}</div>`
  );
};

/** The "Booking Date" label for one booking, from its stored range through
 * {@link bookedRangeLabel}. That reader covers a legacy row with no stored end
 * by the listing's fixed duration. The ticket card and the confirmation email
 * then describe the same stay. */
const computeBookingDateLabel = (entry: TokenEntry): string =>
  bookedRangeLabel(
    entry.attendee.date,
    entry.attendee.end_date,
    clampDurationDays(entry.listing.duration_days),
  );

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
const renderQrBlock = (token: string, purchaseOnly: boolean): string => {
  if (purchaseOnly) return "";
  return String(
    <>
      <div class="ticket-card-qr">
        <img alt={t("listing_qr.qr_code")} src={`/t/${token}/svg`} />
      </div>
      <div class="ticket-card-token">{token}</div>
    </>,
  );
};

const renderPackageCard = (
  cards: TicketCard[],
  packageInfo: PackageDisplay,
): string => {
  const { token } = cards[0]!;
  const purchaseOnly = allCardsPurchaseOnly(cards);
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
  const widestDated = widestDatedEntry(cards.map((c) => c.entry));
  const dateHtml = widestDated
    ? `<div class="ticket-card-date">${t("tickets.booking_date")} ${escapeHtml(
        computeBookingDateLabel(widestDated),
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

  const bookingDateLabel = computeBookingDateLabel(entry);
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

  const modifiers = card.modifiers ?? [];
  const modifiersHtml = renderModifiers(modifiers, pricePaid);

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
      ${modifiersHtml}
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

/** One thing the card list renders: a package's whole bucket, in the slot of
 *  its first card, or one normal card. */
type CardUnit =
  | { bucket: TicketCard[]; display: PackageDisplay; kind: "package" }
  | { card: TicketCard; kind: "card"; tokenHasPackage: boolean };

/** Group the cards into the units the page renders: package rows collapse into
 *  one bucket per (token, package), and every other row stays its own card.
 *  The direct wallet endpoints 404 any token whose entries include a package
 *  row (lookupSingleTokenPassData), so a standalone card under such a token
 *  carries `tokenHasPackage`, and it advertises no wallet links. */
const cardUnits = (
  cards: TicketCard[],
  displayFor: (card: TicketCard) => PackageDisplay | undefined,
): CardUnit[] => {
  const packageTokens = new Set(
    cards.filter((card) => displayFor(card)).map((card) => card.token),
  );
  const units: CardUnit[] = [];
  const openBuckets = new Map<
    string,
    { bucket: TicketCard[]; display: PackageDisplay; kind: "package" }
  >();
  for (const card of cards) {
    const display = displayFor(card);
    if (!display) {
      units.push({
        card,
        kind: "card",
        tokenHasPackage: packageTokens.has(card.token),
      });
      continue;
    }
    const key = packageCardKey(card);
    const open = openBuckets.get(key);
    if (open) {
      open.bucket.push(card);
      continue;
    }
    const unit = { bucket: [card], display, kind: "package" as const };
    openBuckets.set(key, unit);
    units.push(unit);
  }
  return units;
};

/** Render each card to HTML: a package row collapses into one package card per
 * bucket (rendered once); any other row is a normal card — with wallet links
 * suppressed when its token also carries a package (the pass would 404). */
const renderCardsHtml = (
  cards: TicketCard[],
  packageDisplays: ReadonlyMap<number, PackageDisplay>,
  appleWalletEnabled: boolean,
  googleWalletEnabled: boolean,
): string[] => {
  // Resolve each card's package display (only for a real, non-zero package id).
  // A row with no display renders as its own normal card — so a token mixing a
  // hidden package with a standalone booking collapses the package (hiding its
  // members) while still showing the standalone ticket.
  const displayFor = (card: TicketCard): PackageDisplay | undefined =>
    packageDisplays.get(card.entry.attendee.package_group_id);
  return cardUnits(cards, displayFor).map((unit) =>
    unit.kind === "package"
      ? renderPackageCard(unit.bucket, unit.display)
      : renderTicketCard(
          unit.card,
          appleWalletEnabled && !unit.tokenHasPackage,
          googleWalletEnabled && !unit.tokenHasPackage,
        ),
  );
};

export const ticketViewPage = (
  cards: TicketCard[],
  appleWalletEnabled = false,
  googleWalletEnabled = false,
  packageDisplays: ReadonlyMap<number, PackageDisplay> = new Map(),
): string => {
  const htmlParts = renderCardsHtml(
    cards,
    packageDisplays,
    appleWalletEnabled,
    googleWalletEnabled,
  );
  const cardHtml = htmlParts.join("");

  const allPurchaseOnly = allCardsPurchaseOnly(cards);
  // Each package collapses to one card, so count rendered cards (not member rows)
  // in the heading rather than revealing a package's member count.
  const heading = allPurchaseOnly
    ? "Your Purchase"
    : ticketCount(htmlParts.length);
  const title = allPurchaseOnly ? "Your Purchase" : t("tickets.title");

  return headingLayoutPage(
    heading,
    title,
    "public",
  )(
    <div class="ticket-slider">
      <Raw html={cardHtml} />
    </div>,
  );
};
