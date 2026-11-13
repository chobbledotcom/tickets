import type { TicketListing } from "#booking/model.ts";
import type { ListingAttributesById } from "#db/attributes.ts";
import { joinStrings, partition } from "#fp";
import { t } from "#i18n";
import { escapeHtml } from "#jsx/escape-html.ts";
import { Raw } from "#jsx/jsx-runtime.ts";
import { formatCurrency } from "#shared/currency.ts";
import { formatDateLabel } from "#shared/date-labels.ts";
import { formatDatetimeLabel } from "#shared/dates.ts";
import { isReadOnly } from "#shared/env.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import { Badge } from "#templates/components/badge.tsx";
import { CARD_GRID_CLASS, cardInner } from "#templates/components/card.tsx";
import type { Group } from "#types";
import { listingAttributesHtml } from "./listing-attributes.ts";
import {
  compareGroupsByName,
  PackagesSection,
  type PublicNavProps,
  publicPage,
  renderListingImage,
  titleWithSiteName,
} from "./shared.tsx";

/** A red {@link Badge} status line for the two date-search failure messages
 *  ("Sold Out" and "Not available on {date}") — rendered as a paragraph so it
 *  sits inline with the other prose paragraphs it lives alongside. */
const statusBadgeParagraph = (message: string): string =>
  `<p>${String(<Badge variant="danger">{message}</Badge>)}</p>`;

/** How a public listing card should treat a child listing. A booking can never
 * start from a child, so a child never gets a standalone Book/Buy
 * CTA: `"addon"` (the child has a live parent page) shows the "available as an
 * add-on" note, while `"unavailable"` (no active parent page can offer it) reads
 * as currently unavailable rather than pointing at a dead end. `"none"` is an
 * ordinary, non-child listing. */
export type ChildCardState = "none" | "addon" | "unavailable";

/** Map a listing id to its {@link ChildCardState} from the discovery child
 * classification: a child with a bookable parent → add-on; any other child →
 * unavailable; a non-child → none. */
export const childCardState =
  (childIds: ReadonlySet<number>, addOnChildIds: ReadonlySet<number>) =>
  (id: number): ChildCardState =>
    addOnChildIds.has(id) ? "addon" : childIds.has(id) ? "unavailable" : "none";

/** The /listings `?date=` filter for DAILY cards. Present whenever the
 * page shows daily listings — their capacity is a per-date fact, so their
 * cards make no availability claim until the visitor picks a date here.
 * `date` is the validated chosen date (null when none picked yet) and
 * `unavailableIds` the daily listings that can't serve it (outside their
 * calendar, or full on it). */
export type DailyDateFilter = {
  date: string | null;
  unavailableIds: ReadonlySet<number>;
};

/** The date-filter form inviting a date for the page's daily cards, with the
 * chosen date kept in the field and a reset link back to the unfiltered page. */
const renderDateFilter = (filter: DailyDateFilter): string => {
  const clear = filter.date
    ? ` <a href="/listings">${t("public.date_filter.show_all")}</a>`
    : "";
  return `<form method="get" action="/listings" class="listings-date-filter">
    <label for="listings-date">${t("public.date_filter.label")}</label>
    <input type="date" id="listings-date" name="date" value="${escapeHtml(
      filter.date ?? "",
    )}" />
    <button type="submit">${t("public.date_filter.search")}</button>${clear}
  </form>`;
};

/** Booking CTA / status line for a public listing card. A child listing is
 * never standalone-bookable, so its Book/Buy button is replaced
 * with the "available as an add-on" note (a child with a live bookable parent)
 * or the "currently unavailable" note (a child with no bookable parent to offer
 * it)
 * — but only when the child is otherwise bookable: an unavailable child (sold
 * out / closed / read-only site) must still read as such, so those checks run
 * first. */
/** A daily card's `?date=`-filtered state: the filtered date it can
 * serve (carried into its Book CTA so the booking page pre-selects it), the
 * date it can't ("filtered-out"), or no filter in play for this card. */
type CardDateState =
  | { kind: "none" }
  | { kind: "serves"; date: string }
  | { kind: "filtered-out"; date: string };

/** Resolve a card's {@link CardDateState} from the page's date filter: only a
 * DAILY card with a chosen date is judged; every other card is date-neutral. */
const cardDateState = (
  info: TicketListing,
  filter: DailyDateFilter | null,
): CardDateState => {
  if (
    info.listing.listing_type !== "daily" ||
    filter === null ||
    filter.date === null
  ) {
    return { kind: "none" };
  }
  return filter.unavailableIds.has(info.listing.id)
    ? { date: filter.date, kind: "filtered-out" }
    : { date: filter.date, kind: "serves" };
};

/** A card's booking CTA / status line, described in one place so the page
 *  can't disagree with itself about a card:
 *  - `insideProse` — WHERE the line sits: the date-search failures ("Sold
 *    Out", "Not available on {date}") render as a red {@link Badge} inside
 *    the card's `.prose` block; every other state is a sibling after it.
 *  - `unavailable` — whether the card has no live booking path at all: the
 *    set a date search moves into the page's "Unavailable" section. An
 *    add-on note is not an availability failure (the item is bookable
 *    through its parent), so it stays with the available cards.
 *  - `bookable` — whether the CTA IS the live Book/Buy link (not a status
 *    note): the gallery card makes the whole card that link. */
type CardCta = {
  html: string;
  insideProse: boolean;
  unavailable: boolean;
  bookable: boolean;
};

/** The two prose-Badge failure states share one shape. */
const unavailableBadgeCta = (message: string): CardCta => ({
  bookable: false,
  html: statusBadgeParagraph(message),
  insideProse: true,
  unavailable: true,
});

/** Everything else renders after the prose block. Only the Book/Buy link CTA
 *  is `bookable`. */
const plainCta = (
  html: string,
  unavailable: boolean,
  bookable = false,
): CardCta => ({
  bookable,
  html,
  insideProse: false,
  unavailable,
});

const renderListingCardCta = (
  info: TicketListing,
  childState: ChildCardState,
  dateState: CardDateState,
): CardCta => {
  const { listing, isSoldOut, isClosed } = info;
  if (isSoldOut) return unavailableBadgeCta(t("public.sold_out"));
  if (isClosed || isReadOnly()) {
    return plainCta(
      `<p><strong>${t("public.registration_closed")}</strong></p>`,
      true,
    );
  }
  if (dateState.kind === "filtered-out") {
    return unavailableBadgeCta(
      t("public.date_filter.unavailable_on", {
        date: formatDateLabel(dateState.date),
      }),
    );
  }
  if (childState === "addon") {
    return plainCta(
      `<p><em>${t("public.available_with_other")}</em></p>`,
      false,
    );
  }
  if (childState === "unavailable") {
    return plainCta(
      `<p><strong>${t("public.currently_unavailable")}</strong></p>`,
      true,
    );
  }
  const bookLabel = listing.purchase_only
    ? t("public.buy_now")
    : t("public.book_now");
  const dateQuery =
    dateState.kind === "serves"
      ? `?date=${encodeURIComponent(dateState.date)}`
      : "";
  return plainCta(
    `<p><a class="btn" href="/ticket/${escapeHtml(
      listing.slug,
    )}${dateQuery}">${bookLabel}</a></p>`,
    false,
    true,
  );
};

/** A card rendered to html, tagged with whether it belongs in the
 *  "Unavailable" section once a date search is active. */
type RenderedCard = { html: string; unavailable: boolean };

/** Render one listing card. */
const renderListingCard =
  (
    childStateOf: (id: number) => ChildCardState,
    dateFilter: DailyDateFilter | null,
    attributesByListing: ListingAttributesById,
  ) =>
  (info: TicketListing): RenderedCard => {
    const { listing } = info;
    const dateHtml = listing.date
      ? `<p><em>${escapeHtml(formatDatetimeLabel(listing.date))}</em></p>`
      : "";
    const locationHtml = listing.location
      ? `<p><strong>${escapeHtml(listing.location)}</strong></p>`
      : "";
    const descriptionHtml = listing.description
      ? renderMarkdown(listing.description)
      : "";
    const attributesHtml = listingAttributesHtml(
      attributesByListing,
      listing.id,
    );
    const cta = renderListingCardCta(
      info,
      childStateOf(listing.id),
      cardDateState(info, dateFilter),
    );

    const proseHtml = `<div class="prose"><h2>${escapeHtml(
      listing.name,
    )}</h2>${dateHtml}${locationHtml}${descriptionHtml}${attributesHtml}${
      cta.insideProse ? cta.html : ""
    }</div>`;
    return {
      html: `${proseHtml}${cta.insideProse ? "" : cta.html}`,
      unavailable: cta.unavailable,
    };
  };

/** A gallery card's detail lines: the price (with the "from" prefix when the
 *  listing lets buyers pay more), then the date and location when present. */
const galleryDetailHtml = (listing: TicketListing["listing"]): string => {
  const priceHtml =
    listing.unit_price > 0
      ? `<span class="card-price">${
          listing.can_pay_more ? t("availability.from_prefix") : ""
        }${escapeHtml(formatCurrency(listing.unit_price))}</span>`
      : "";
  const dateHtml = listing.date
    ? `<span><em>${escapeHtml(formatDatetimeLabel(listing.date))}</em></span>`
    : "";
  const locationHtml = listing.location
    ? `<span>${escapeHtml(listing.location)}</span>`
    : "";
  return `${priceHtml}${dateHtml}${locationHtml}`;
};

/** Render one listing as a product-gallery card — the shop-index look the
 *  catalog-gallery setting switches the listings page to. The shared media
 *  card (image, name, detail lines) reuses the order gallery's and news
 *  list's `.card` layout. A bookable listing's whole card is the Book/Buy
 *  link, while every non-bookable state keeps the card but swaps the link
 *  for its status note. No description: the gallery is an index — the long
 *  form stays on the listing's own page. */
const renderGalleryCard =
  (
    childStateOf: (id: number) => ChildCardState,
    dateFilter: DailyDateFilter | null,
  ) =>
  (info: TicketListing): RenderedCard => {
    const { listing } = info;
    const dateState = cardDateState(info, dateFilter);
    const cta = renderListingCardCta(info, childStateOf(listing.id), dateState);
    const body = cardInner({
      detailHtml: galleryDetailHtml(listing),
      imageHtml: renderListingImage(listing, "card-image", { thumb: true }),
      name: listing.name,
    });
    const dateQuery =
      cta.bookable && dateState.kind === "serves"
        ? `?date=${encodeURIComponent(dateState.date)}`
        : "";
    const html = cta.bookable
      ? `<a class="card" href="/ticket/${escapeHtml(listing.slug)}${dateQuery}">${body}</a>`
      : `<div class="card">${body}${cta.html}</div>`;
    return { html, unavailable: cta.unavailable };
  };

/** Render one group card (same style as a listing card). A package that's
 *  sold out for the searched date shows the same red "Sold Out" badge,
 *  inside its `.prose` block, instead of a Book link that could only fail. */
const renderGroupCard = (group: Group, soldOut: boolean): string => {
  const descriptionHtml = group.description
    ? renderMarkdown(group.description)
    : "";
  if (soldOut) {
    return `<div class="prose"><h2>${escapeHtml(
      group.name,
    )}</h2>${descriptionHtml}${statusBadgeParagraph(
      t("public.sold_out"),
    )}</div>`;
  }
  const linkHtml = isReadOnly()
    ? `<p><strong>${t("public.registration_closed")}</strong></p>`
    : `<p><a class="btn" href="/ticket/${escapeHtml(
        group.slug,
      )}">${t("public.book_now")}</a></p>`;

  return `<div class="prose"><h2>${escapeHtml(
    group.name,
  )}</h2>${descriptionHtml}</div>${linkHtml}`;
};

/**
 * Homepage with listings - lists all active upcoming listings with booking links.
 * With `galleryView` on (the catalog-gallery setting), the listing cards render
 * as a product-card gallery instead of the classic prose cards.
 */
export const homepagePage = (
  listings: TicketListing[],
  websiteTitle: string,
  groups: Group[],
  childStateOf: (id: number) => ChildCardState,
  dateFilter: DailyDateFilter | null,
  nav: PublicNavProps,
  soldOutPackageIds: ReadonlySet<number>,
  requestedDate: string | null,
  attributesByListing: ListingAttributesById,
  galleryView = false,
): string => {
  const title = titleWithSiteName(t("terms.listings"), websiteTitle);

  if (listings.length === 0 && groups.length === 0) {
    return publicPage(
      title,
      websiteTitle,
      nav,
    )(
      <p>
        <em>{t("public.no_listings_listed")}</em>
      </p>,
    );
  }

  // Packages are sold as bundles, so they lead the page under their own heading;
  // regular groups and individual listings follow together. Each set is sorted by
  // decrypted name in app code (SQL can't order the encrypted column).
  const renderGroupCards = (gs: Group[]): string =>
    joinStrings(gs.map((g) => renderGroupCard(g, soldOutPackageIds.has(g.id))));
  const packageGroups = groups
    .filter((g) => g.is_package)
    .toSorted(compareGroupsByName);
  const regularGroups = groups
    .filter((g) => !g.is_package)
    .toSorted(compareGroupsByName);

  // The date search splits the page into available/unavailable sections only
  // once a date has actually been chosen; with no date picked yet nothing
  // moves and every card renders in the single combined list, unchanged from
  // before. The split keys off `requestedDate` — NOT `dateFilter`, which is
  // null whenever no standalone daily card needs the filter form, even though
  // a package's (hidden) daily members can still make it sold out for the
  // searched date.
  const keepTogether = <T,>(items: T[]): [T[], T[]] => [items, []];
  const [availablePackages, unavailablePackages] = (
    requestedDate === null
      ? keepTogether
      : partition((g: Group) => !soldOutPackageIds.has(g.id))
  )(packageGroups);
  const renderCard = galleryView
    ? renderGalleryCard(childStateOf, dateFilter)
    : renderListingCard(childStateOf, dateFilter, attributesByListing);
  const listingCards = listings.map(renderCard);
  const [availableCards, unavailableCards] = (
    requestedDate === null
      ? keepTogether
      : partition((card: RenderedCard) => !card.unavailable)
  )(listingCards);
  const cardsHtml = (cards: RenderedCard[]): string =>
    joinStrings(cards.map((card) => card.html));
  const hasUnavailableSection =
    unavailablePackages.length > 0 || unavailableCards.length > 0;

  return publicPage(
    title,
    websiteTitle,
    nav,
  )(
    <>
      {dateFilter !== null && <Raw html={renderDateFilter(dateFilter)} />}
      <PackagesSection groups={availablePackages}>
        <Raw html={renderGroupCards(availablePackages)} />
      </PackagesSection>
      <h2>{t("public.all_bookable_listings")}</h2>
      <Raw html={renderGroupCards(regularGroups)} />
      {galleryView ? (
        <div class={CARD_GRID_CLASS}>
          <Raw html={cardsHtml(availableCards)} />
        </div>
      ) : (
        <Raw html={cardsHtml(availableCards)} />
      )}
      {hasUnavailableSection && (
        <>
          <h2>{t("public.date_filter.unavailable_heading")}</h2>
          <Raw html={renderGroupCards(unavailablePackages)} />
          {galleryView ? (
            <div class={CARD_GRID_CLASS}>
              <Raw html={cardsHtml(unavailableCards)} />
            </div>
          ) : (
            <Raw html={cardsHtml(unavailableCards)} />
          )}
        </>
      )}
    </>,
  );
};
