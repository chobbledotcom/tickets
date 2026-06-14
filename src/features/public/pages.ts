/**
 * Public pages - home, listings, terms, contact
 */

import {
  htmlResponse,
  notFoundResponse,
  redirectResponse,
} from "#routes/response.ts";
import { getAllGroups } from "#shared/db/groups.ts";
import { settings } from "#shared/db/settings.ts";
import { loadSortedListings } from "#shared/sort-listings.ts";
import type { Group, ListingWithCount } from "#shared/types.ts";
import {
  homepagePage,
  type PublicPageType,
  publicSitePage,
} from "#templates/public.tsx";
import { buildTicketListingsWithGroupCapacity } from "./ticket-listings.ts";

/** Active+visible filter for public listing listings */
const isPublicListing = (e: ListingWithCount): boolean => e.active && !e.hidden;

/** Load non-hidden groups (for public listing) */
const loadPublicGroups = async (): Promise<Group[]> => {
  const groups = await getAllGroups();
  return groups.filter((g) => !g.hidden);
};

/** Guard: redirect to admin login if public site is disabled */
const requirePublicSite = <T>(fn: () => T): T | Response =>
  settings.showPublicSite ? fn() : redirectResponse("/admin/login");

/** Render a public site page with website title and content */
const renderPublicPage = (
  pageType: PublicPageType,
  getContent: () => string | null,
): Response =>
  requirePublicSite(() => {
    const content = getContent();
    return htmlResponse(
      publicSitePage(pageType, settings.websiteTitle, content),
    );
  });

/** Handle GET / (home page) - redirect to admin or show public site */
export const handleHome = (): Response =>
  renderPublicPage("home", () => settings.homepageText);

/** Handle GET /listings - public listings listing */
export const handlePublicListings = (): Response | Promise<Response> =>
  requirePublicSite(async () => {
    const [groups, { listings }] = await Promise.all([
      loadPublicGroups(),
      loadSortedListings(isPublicListing),
    ]);
    const ticketListings = await buildTicketListingsWithGroupCapacity(listings);
    return htmlResponse(
      homepagePage(ticketListings, settings.websiteTitle, groups),
    );
  });

/** Handle GET /terms - public terms and conditions page (404 when empty) */
export const handlePublicTerms = (): Response =>
  requirePublicSite(() =>
    settings.terms
      ? htmlResponse(
          publicSitePage("terms", settings.websiteTitle, settings.terms),
        )
      : notFoundResponse(),
  );

/** Handle GET /contact - public contact page (404 when empty) */
export const handlePublicContact = (): Response =>
  requirePublicSite(() =>
    settings.contactPageText
      ? htmlResponse(
          publicSitePage(
            "contact",
            settings.websiteTitle,
            settings.contactPageText,
          ),
        )
      : notFoundResponse(),
  );
