import { t } from "#i18n";
import { isContactFormActive } from "#shared/contact-form.ts";
import { settings } from "#shared/db/settings.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { getImageProxyUrl } from "#shared/storage.ts";
import { escapeHtml } from "#templates/layout.tsx";

/** Public site navigation - hides terms/contact/order links when off/empty */
export const PublicNav = ({
  hasTerms,
  hasContact,
  hasOrder,
}: {
  hasTerms?: boolean;
  hasContact?: boolean;
  hasOrder?: boolean;
}): JSX.Element => (
  <nav>
    <ul>
      <li>
        <a href="/">{t("nav.public.home")}</a>
      </li>
      <li>
        <a href="/listings">{t("terms.listings")}</a>
      </li>
      {hasOrder && (
        <li>
          <a href="/order">{t("nav.public.order")}</a>
        </li>
      )}
      {hasTerms && (
        <li>
          <a href="/terms">
            <Raw html={t("nav.public.terms")} />
          </a>
        </li>
      )}
      {hasContact && (
        <li>
          <a href="/contact">{t("nav.public.contact")}</a>
        </li>
      )}
    </ul>
  </nav>
);

/** Compute which public pages have content.
 * The Contact link also shows when the contact form is active, even if the
 * contact page has no descriptive text of its own. The Order link shows
 * whenever the owner has enabled the order page. */
export const navFlags = () => ({
  hasContact: !!settings.contactPageText || isContactFormActive(),
  hasOrder: settings.orderEnabled,
  hasTerms: !!settings.terms,
});

export const RSS_DISCOVERY_TAG =
  '<link rel="alternate" type="application/rss+xml" title="Listings" href="/feeds/listings.rss" />';

export const ICS_DISCOVERY_TAG =
  '<link rel="alternate" type="text/calendar" title="Listings" href="/feeds/listings.ics" />';

export const FEED_DISCOVERY_TAGS = `${RSS_DISCOVERY_TAG}\n${ICS_DISCOVERY_TAG}`;

/** Render listing image HTML if image_url is set */
export const renderListingImage = (
  listing: { image_url: string },
  className = "listing-image",
): string =>
  listing.image_url
    ? `<img src="${escapeHtml(
        getImageProxyUrl(listing.image_url),
      )}" alt="" class="${className}" />`
    : "";

/** Listing info for ticket display */
export type TicketListing = {
  listing: import("#shared/types.ts").ListingWithCount;
  isSoldOut: boolean;
  isClosed: boolean;
  maxPurchasable: number;
};

/** Whether a required child clears the date- AND span-INDEPENDENT disqualifiers:
 * it is active, not registration-closed, and — for a STANDARD child, whose
 * capacity is cumulative and date-independent — not sold out. A DAILY child's
 * date-less `isSoldOut` aggregate is meaningless (it reads true once full on ANY
 * single date), so a daily child is never filtered on it here — its per-date
 * capacity is enforced against the resolved date downstream.
 *
 * This is the single source of truth both the date union (ticket-payment.ts) and
 * the day-count union (reservations.tsx) use to drop children the fold would
 * categorically reject, so an inactive/closed/sold-out child never keeps a
 * date/span selectable (parents.md Fixes 2–4). Span- and date-dependent checks
 * (priced-for-duration, fixed-daily duration match, the child's own calendar)
 * layer on top of this in the caller that knows the inherited span/date. */
export const childSelectableIgnoringSpan = (child: TicketListing): boolean =>
  child.listing.active &&
  !child.isClosed &&
  (child.listing.listing_type === "daily" || !child.isSoldOut);

/** `groupRemaining`, when defined, clamps the displayed sold-out state and
 * `maxPurchasable` to the group's combined cap. */
export const buildTicketListing = (
  listing: import("#shared/types.ts").ListingWithCount,
  closed: boolean,
  groupRemaining: number | undefined,
): TicketListing => {
  const listingRemaining = listing.max_attendees - listing.attendee_count;
  const spotsRemaining =
    groupRemaining === undefined
      ? listingRemaining
      : Math.min(listingRemaining, groupRemaining);
  const isSoldOut = spotsRemaining <= 0;
  const maxPurchasable =
    isSoldOut || closed ? 0 : Math.min(listing.max_quantity, spotsRemaining);
  return { isClosed: closed, isSoldOut, listing, maxPurchasable };
};
