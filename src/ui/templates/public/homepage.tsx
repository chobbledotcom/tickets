import { map, pipe } from "#fp";
import { t } from "#i18n";
import { formatDatetimeLabel } from "#shared/dates.ts";
import { isReadOnly } from "#shared/env.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import type { Group } from "#shared/types.ts";
import { escapeHtml, Layout } from "#templates/layout.tsx";
import {
  FEED_DISCOVERY_TAGS,
  PublicNav,
  type PublicNavProps,
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

/** Booking CTA / status line for a public listing card. A child listing is
 * never standalone-bookable (invariant I3), so its Book/Buy button is replaced
 * with the "available as an add-on" note (a child with a live bookable parent)
 * or the "currently unavailable" note (a child with no bookable parent to offer
 * it)
 * — but only when the child is otherwise bookable: an unavailable child (sold
 * out / closed / read-only site) must still read as such, so those checks run
 * first (parents.md, "Public listing cards"). */
const renderListingCardCta = (
  info: TicketListing,
  childState: ChildCardState,
): string => {
  const { listing, isSoldOut, isClosed } = info;
  if (isSoldOut) return `<p><strong>${t("public.sold_out")}</strong></p>`;
  if (isClosed || isReadOnly()) {
    return `<p><strong>${t("public.registration_closed")}</strong></p>`;
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
  return `<p><a class="btn" href="/ticket/${escapeHtml(
    listing.slug,
  )}">${bookLabel}</a></p>`;
};

/** Render a single listing listing for the listings page */
const renderListingListing =
  (childStateOf: (id: number) => ChildCardState) =>
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
    const linkHtml = renderListingCardCta(info, childStateOf(listing.id));

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
  nav: PublicNavProps,
): string => {
  const listingsTitle = t("terms.listings");
  const title = websiteTitle
    ? `${listingsTitle} - ${websiteTitle}`
    : listingsTitle;

  if (listings.length === 0 && groups.length === 0) {
    return String(
      <Layout headExtra={FEED_DISCOVERY_TAGS} title={title}>
        {websiteTitle && <h1>{websiteTitle}</h1>}
        <PublicNav {...nav} />
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

  const groupListings = pipe(map(renderGroupListing), (rows) => rows.join(""))(
    groups,
  );

  const listingListings = pipe(
    map(renderListingListing(childStateOf)),
    (rows) => rows.join(""),
  )(listings);

  return String(
    <Layout headExtra={FEED_DISCOVERY_TAGS} title={title}>
      {websiteTitle && <h1>{websiteTitle}</h1>}
      <PublicNav {...nav} />
      <h2>{t("public.all_bookable_listings")}</h2>
      <Raw html={groupListings} />
      <Raw html={listingListings} />
      <footer class="homepage-footer">
        <p>
          <a href="/admin/login">{t("common.login")}</a>
        </p>
      </footer>
    </Layout>,
  );
};
