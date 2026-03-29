/**
 * Public pages - home, events, terms, contact
 */

import { settings } from "#lib/db/settings.ts";
import { loadSortedEvents } from "#lib/sort-events.ts";
import type { EventWithCount } from "#lib/types.ts";
import {
  htmlResponse,
  isRegistrationClosed,
  notFoundResponse,
  redirectResponse,
} from "#routes/utils.ts";
import {
  buildTicketEvent,
  homepagePage,
  type PublicPageType,
  publicSitePage,
  type TicketEvent,
} from "#templates/public.tsx";

/** Active+visible filter for public event listings */
const isPublicEvent = (e: EventWithCount): boolean => e.active && !e.hidden;

/** Load active events for the homepage, sorted and with registration status */
const loadHomepageEvents = async (): Promise<TicketEvent[]> => {
  const { events } = await loadSortedEvents(isPublicEvent);
  return events.map((e) => buildTicketEvent(e, isRegistrationClosed(e)));
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
    const events = await loadHomepageEvents();
    return htmlResponse(homepagePage(events, settings.websiteTitle));
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
