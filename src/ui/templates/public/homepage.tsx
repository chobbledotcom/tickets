/* jscpd:ignore-start */
import { joinStrings, partition } from "#fp";
import { t } from "#i18n";
import type { TicketListing } from "#shared/booking/model.ts";
import { formatDateLabel, formatDatetimeLabel } from "#shared/dates.ts";
import type { ListingAttributesById } from "#shared/db/attributes.ts";
import { isReadOnly } from "#shared/env.ts";
import { escapeHtml } from "#shared/jsx/escape-html.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import type { Group } from "#shared/types.ts";
import { Badge } from "#templates/components/badge.tsx";
import { listingAttributesHtml } from "./listing-attributes.ts";
import {
  compareGroupsByName,
  PackagesSection,
  type PublicNavProps,
  /* jscpd:ignore-end */
  publicPage,
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
 *  - `insideProse` says WHERE the line belongs — the two date-search failure
 *    messages ("Sold Out", "Not available on {date}") live inside the card's
 *    `.prose` block as a red {@link Badge}; every other state (registration
 *    closed, add-on note, currently-unavailable note, the actual Book/Buy
 *    link) is a sibling after `.prose`.
 *  - `unavailable` says whether the card has no live booking path at all —
 *    the set a date search moves into the page's "Unavailable" section. An
 *    add-on note is not an availability failure (the item is bookable through
 *    its parent), so it stays with the available cards. */
type CardCta = { html: string; insideProse: boolean; unavailable: boolean };

/** The two prose-Badge failure states share one shape. */
const unavailableBadgeCta = (message: string): CardCta => ({
  html: statusBadgeParagraph(message),
  insideProse: true,
  unavailable: true,
});

/** Everything else renders after the prose block. */
const plainCta = (html: string, unavailable: boolean): CardCta => ({
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
 * Homepage with listings - lists all active upcoming listings with booking links
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
  const listingCards = listings.map(
    renderListingCard(childStateOf, dateFilter, attributesByListing),
  );
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
      <Raw html={cardsHtml(availableCards)} />
      {hasUnavailableSection && (
        <>
          <h2>{t("public.date_filter.unavailable_heading")}</h2>
          <Raw html={renderGroupCards(unavailablePackages)} />
          <Raw html={cardsHtml(unavailableCards)} />
        </>
      )}
    </>,
  );
};
