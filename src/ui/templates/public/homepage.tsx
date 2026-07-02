import { map, pipe } from "#fp";
import { t } from "#i18n";
import { formatDateLabel, formatDatetimeLabel } from "#shared/dates.ts";
import { isReadOnly } from "#shared/env.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import type { Group } from "#shared/types.ts";
import { escapeHtml, Layout } from "#templates/layout.tsx";
import {
  FEED_DISCOVERY_TAGS,
  navFlags,
  PublicNav,
  type TicketListing,
} from "./shared.tsx";

/** How a public listing card should treat a child listing. A booking can never
 * start from a child (invariant I3), so a child never gets a standalone Book/Buy
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

/** The /listings `?date=` filter for DAILY cards (#51). Present whenever the
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
 * never standalone-bookable (invariant I3), so its Book/Buy button is replaced
 * with the "available as an add-on" note (a child with a live bookable parent)
 * or the "currently unavailable" note (a child with no bookable parent to offer
 * it)
 * — but only when the child is otherwise bookable: an unavailable child (sold
 * out / closed / read-only site) must still read as such, so those checks run
 * first (parents.md, "Public listing cards"). */
/** A daily card's `?date=`-filtered state (#51): the filtered date it can
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

const renderListingCardCta = (
  info: TicketListing,
  childState: ChildCardState,
  dateState: CardDateState,
): string => {
  const { listing, isSoldOut, isClosed } = info;
  if (isSoldOut) return `<p><strong>${t("public.sold_out")}</strong></p>`;
  if (isClosed || isReadOnly()) {
    return `<p><strong>${t("public.registration_closed")}</strong></p>`;
  }
  if (dateState.kind === "filtered-out") {
    return `<p><strong>${t("public.date_filter.unavailable_on", {
      date: formatDateLabel(dateState.date),
    })}</strong></p>`;
  }
  if (childState === "addon") {
    return `<p><em>${t("public.available_with_other")}</em></p>`;
  }
  if (childState === "unavailable") {
    return `<p><strong>${t("public.currently_unavailable")}</strong></p>`;
  }
  const bookLabel = listing.purchase_only
    ? t("public.buy_now")
    : t("public.book_now");
  const dateQuery =
    dateState.kind === "serves"
      ? `?date=${encodeURIComponent(dateState.date)}`
      : "";
  return `<p><a class="btn" href="/ticket/${escapeHtml(
    listing.slug,
  )}${dateQuery}">${bookLabel}</a></p>`;
};

/** Render a single listing listing for the listings page */
const renderListingListing =
  (
    childStateOf: (id: number) => ChildCardState,
    dateFilter: DailyDateFilter | null,
  ) =>
  (info: TicketListing): string => {
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
    const linkHtml = renderListingCardCta(
      info,
      childStateOf(listing.id),
      cardDateState(info, dateFilter),
    );

    return `<div class="prose"><h2>${escapeHtml(
      listing.name,
    )}</h2>${dateHtml}${locationHtml}${descriptionHtml}</div>${linkHtml}`;
  };

/** Render a single group listing for the listings page (same style as listings) */
const renderGroupListing = (group: Group): string => {
  const descriptionHtml = group.description
    ? renderMarkdown(group.description)
    : "";
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
  websiteTitle: string | null | undefined,
  groups: Group[],
  childStateOf: (id: number) => ChildCardState,
  dateFilter: DailyDateFilter | null,
): string => {
  const listingsTitle = t("terms.listings");
  const title = websiteTitle
    ? `${listingsTitle} - ${websiteTitle}`
    : listingsTitle;

  if (listings.length === 0 && groups.length === 0) {
    return String(
      <Layout headExtra={FEED_DISCOVERY_TAGS} title={title}>
        {websiteTitle && <h1>{websiteTitle}</h1>}
        <PublicNav {...navFlags()} />
        <p>
          <em>{t("public.no_listings_listed")}</em>
        </p>
        <footer class="homepage-footer">
          <p>
            <a href="/admin/login">{t("common.login")}</a>
          </p>
        </footer>
      </Layout>,
    );
  }

  // Packages are sold as bundles, so they lead the page under their own heading;
  // regular groups and individual listings follow together. Each set is sorted by
  // decrypted name in app code (SQL can't order the encrypted column).
  const byName = (a: Group, b: Group): number => a.name.localeCompare(b.name);
  const renderGroupCards = (gs: Group[]): string =>
    pipe(map(renderGroupListing), (rows) => rows.join(""))(gs);
  const packageGroups = groups.filter((g) => g.is_package).toSorted(byName);
  const regularGroups = groups.filter((g) => !g.is_package).toSorted(byName);

  const listingListings = pipe(
    map(renderListingListing(childStateOf, dateFilter)),
    (rows) => rows.join(""),
  )(listings);

  return String(
    <Layout headExtra={FEED_DISCOVERY_TAGS} title={title}>
      {websiteTitle && <h1>{websiteTitle}</h1>}
      <PublicNav {...navFlags()} />
      {dateFilter !== null && <Raw html={renderDateFilter(dateFilter)} />}
      {packageGroups.length > 0 && (
        <>
          <h2>{t("public.packages")}</h2>
          <Raw html={renderGroupCards(packageGroups)} />
        </>
      )}
      <h2>{t("public.all_bookable_listings")}</h2>
      <Raw html={renderGroupCards(regularGroups)} />
      <Raw html={listingListings} />
      <footer class="homepage-footer">
        <p>
          <a href="/admin/login">{t("common.login")}</a>
        </p>
      </footer>
    </Layout>,
  );
};
