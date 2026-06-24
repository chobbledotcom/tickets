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
  navFlags,
  PublicNav,
  type TicketListing,
} from "./shared.tsx";

/** Render a single listing listing for the listings page */
const renderListingListing = (info: TicketListing): string => {
  const { listing, isSoldOut, isClosed } = info;
  const dateHtml = listing.date
    ? `<p><em>${escapeHtml(formatDatetimeLabel(listing.date))}</em></p>`
    : "";
  const locationHtml = listing.location
    ? `<p><strong>${escapeHtml(listing.location)}</strong></p>`
    : "";
  const descriptionHtml = listing.description
    ? renderMarkdown(listing.description)
    : "";
  const bookLabel = listing.purchase_only
    ? t("public.buy_now")
    : t("public.book_now");
  const linkHtml = isSoldOut
    ? `<p><strong>${t("public.sold_out")}</strong></p>`
    : isClosed || isReadOnly()
      ? `<p><strong>${t("public.registration_closed")}</strong></p>`
      : `<p><a class="btn" href="/ticket/${escapeHtml(
          listing.slug,
        )}">${bookLabel}</a></p>`;

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

  const groupListings = pipe(map(renderGroupListing), (rows) => rows.join(""))(
    groups,
  );

  const listingListings = pipe(map(renderListingListing), (rows) =>
    rows.join(""),
  )(listings);

  return String(
    <Layout headExtra={FEED_DISCOVERY_TAGS} title={title}>
      {websiteTitle && <h1>{websiteTitle}</h1>}
      <PublicNav {...navFlags()} />
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
