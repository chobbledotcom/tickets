/**
 * Public pages - home, events, terms, contact
 */

import { getAllGroups } from "#lib/db/groups.ts";
import { settings } from "#lib/db/settings.ts";
import { loadSortedEvents } from "#lib/sort-events.ts";
import type { EventWithCount, Group } from "#lib/types.ts";
import {
  htmlResponse,
  notFoundResponse,
  redirectResponse,
} from "#routes/response.ts";
import {
  homepagePage,
  type PublicPageType,
  publicSitePage,
} from "#templates/public.tsx";
import { buildTicketEventsWithGroupCapacity } from "./types.ts";

/** Active+visible filter for public event listings */
const isPublicEvent = (e: EventWithCount): boolean => e.active && !e.hidden;

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

/** Handle GET /events - public events listing */
export const handlePublicEvents = (): Response | Promise<Response> =>
  requirePublicSite(async () => {
    const [groups, { events }] = await Promise.all([
      loadPublicGroups(),
      loadSortedEvents(isPublicEvent),
    ]);
    const ticketEvents = await buildTicketEventsWithGroupCapacity(events);
    return htmlResponse(
      homepagePage(ticketEvents, settings.websiteTitle, groups),
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
