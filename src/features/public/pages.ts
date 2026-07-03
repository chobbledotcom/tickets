/**
 * Public pages - home, listings, terms, contact
 */

import { applyFlash, requireMessageField, withCsrfForm } from "#routes/csrf.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirect,
  redirectResponse,
} from "#routes/response.ts";
import { BOTPOISON_FIELD, verifyBotpoisonSolution } from "#shared/botpoison.ts";
import { isBotpoisonEnabled } from "#shared/config.ts";
import {
  contactFormPublicKey,
  isContactFormActive,
  sendContactMessage,
} from "#shared/contact-form.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { getBookableStartDates, parseIsoDateParam } from "#shared/dates.ts";
import { getListingRemainingForRange } from "#shared/db/attendees.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { settings } from "#shared/db/settings.ts";
import type { FormParams } from "#shared/form-data.ts";
import { MESSAGE_SEND_FAILED } from "#shared/inbound-message.ts";
import { loadSortedListings } from "#shared/sort-listings.ts";
import { type ListingWithCount, normalizeDurationDays } from "#shared/types.ts";
import { parseEmail } from "#shared/validation/email.ts";
import {
  childCardState,
  contactPage,
  type DailyDateFilter,
  homepagePage,
  type PublicPageType,
  publicSitePage,
} from "#templates/public.tsx";
import {
  applyParentSoldOut,
  classifyForDiscovery,
  dropHiddenPackageMembers,
  loadPublicGroups,
} from "./discovery.ts";
import { publicNavProps } from "./site-nav.ts";
import { buildTicketListingsWithGroupCapacity } from "./ticket-listings.ts";

/** Active+visible filter for public listing listings */
const isPublicListing = (e: ListingWithCount): boolean => e.active && !e.hidden;

/** Guard: redirect to admin login if public site is disabled */
export const requirePublicSite = <T>(fn: () => T): T | Response =>
  settings.showPublicSite ? fn() : redirectResponse("/admin/login");

/** Render a public site page with website title and content */
const renderPublicPage = (
  pageType: PublicPageType,
  getContent: () => string | null,
): Response | Promise<Response> =>
  requirePublicSite(async () => {
    const content = getContent();
    return htmlResponse(
      publicSitePage(
        pageType,
        await publicNavProps(null),
        settings.websiteTitle,
        content,
      ),
    );
  });

/** Handle GET / (home page) - redirect to admin or show public site */
export const handleHome = (): Response | Promise<Response> =>
  renderPublicPage("home", () => settings.homepageText);

/** The booked span a daily listing's card availability is judged over: a
 * customisable listing offers per-day starts (the span is chosen later), a
 * fixed daily listing books its whole duration. Mirrors
 * {@link getBookableStartDates}'s span. */
const cardSpanDays = (listing: ListingWithCount): number =>
  listing.customisable_days ? 1 : normalizeDurationDays(listing.duration_days);

/** The daily listings NOT bookable on `date`: outside their bookable calendar,
 * or without capacity for their span starting that day. One remaining query
 * per distinct span (via the shared date-aware capacity projection). */
const dailyUnavailableOn = async (
  daily: ListingWithCount[],
  date: string,
): Promise<ReadonlySet<number>> => {
  const holidays = await getActiveHolidays();
  const bySpan = Map.groupBy(daily, cardSpanDays);
  const remaining = new Map<number, number>();
  await Promise.all(
    [...bySpan].map(async ([span, rows]) => {
      const bySpanRemaining = await getListingRemainingForRange(
        rows,
        date,
        span,
      );
      for (const [id, left] of bySpanRemaining) remaining.set(id, left);
    }),
  );
  // Every daily row was passed to exactly one remaining query, so the map is
  // total over `daily` by construction.
  return new Set(
    daily
      .filter(
        (listing) =>
          !getBookableStartDates(listing, holidays).includes(date) ||
          remaining.get(listing.id)! < 1,
      )
      .map((listing) => listing.id),
  );
};

/** The /listings date filter (#51): present whenever daily cards are on the
 * page (so the form renders and invites a date), with per-listing unavailable
 * ids resolved date-aware once a date is chosen. A daily listing's capacity is
 * a per-date fact, so the cards claim nothing until the visitor picks one. */
const buildDailyDateFilter = async (
  listings: ListingWithCount[],
  requestedDate: string | null,
): Promise<DailyDateFilter | null> => {
  const daily = listings.filter((e) => e.listing_type === "daily");
  if (daily.length === 0) return null;
  if (requestedDate === null) return { date: null, unavailableIds: new Set() };
  return {
    date: requestedDate,
    unavailableIds: await dailyUnavailableOn(daily, requestedDate),
  };
};

/** Handle GET /listings - public listings listing. Shows every active, visible
 * listing alongside the non-hidden groups. (Type filtering lives on the admin
 * listings dashboard, not the public page.) When daily listings are shown, a
 * `?date=` filter resolves their per-date availability (#51). */
export const handlePublicListings = (
  request: Request,
): Response | Promise<Response> =>
  requirePublicSite(async () => {
    const [groups, { listings: allListings }, nav] = await Promise.all([
      loadPublicGroups(),
      loadSortedListings(isPublicListing),
      publicNavProps(null),
    ]);
    // A hidden package's members never appear standalone — only the package
    // name is public — so drop them before building the individual cards.
    const listings = await dropHiddenPackageMembers(allListings);
    // Parents with no bookable child read as sold out; a (visible) child keeps
    // its card but loses its standalone Book CTA (invariants I3/I6).
    const classification = await classifyForDiscovery(listings);
    const [ticketListings, dateFilter] = await Promise.all([
      buildTicketListingsWithGroupCapacity(listings),
      buildDailyDateFilter(
        listings,
        parseIsoDateParam(new URL(request.url).searchParams.get("date")),
      ),
    ]);
    return htmlResponse(
      homepagePage(
        applyParentSoldOut(ticketListings, classification),
        settings.websiteTitle,
        groups,
        childCardState(
          classification.nonStandaloneChildIds,
          classification.addOnChildIds,
        ),
        dateFilter,
        nav,
      ),
    );
  });

/** Handle GET /terms - public terms and conditions page (404 when empty) */
export const handlePublicTerms = (): Response | Promise<Response> =>
  requirePublicSite(async () =>
    settings.terms
      ? htmlResponse(
          publicSitePage(
            "terms",
            await publicNavProps(null),
            settings.websiteTitle,
            settings.terms,
          ),
        )
      : notFoundResponse(),
  );

/** Render the contact page (descriptive text and/or the message form).
 * 404 when there is neither contact text nor an active form to show.
 * A fresh CSRF token is minted before rendering when the form is shown. */
const renderContactPage = async (request: Request): Promise<Response> => {
  const formActive = isContactFormActive();
  if (!settings.contactPageText && !formActive) return notFoundResponse();
  if (formActive) await signCsrfToken();
  const flash = applyFlash(request);
  return htmlResponse(
    contactPage({
      botpoisonPublicKey: contactFormPublicKey(),
      content: settings.contactPageText || null,
      ...(flash.error !== undefined ? { error: flash.error } : {}),
      formActive,
      nav: await publicNavProps(null),
      ...(flash.success !== undefined ? { success: flash.success } : {}),
      websiteTitle: settings.websiteTitle,
    }),
  );
};

/** Handle GET /contact - public contact page (404 when empty and form off) */
export const handlePublicContact = (
  request: Request,
): Response | Promise<Response> =>
  requirePublicSite(() => renderContactPage(request));

/** Process a CSRF-checked contact form submission: validate, run Botpoison
 * verification, and only deliver to the owner when verification passes. */
const processContactSubmission = async (
  form: FormParams,
): Promise<Response> => {
  const submitter = parseEmail(form.getString("email"));
  if (!submitter) {
    return errorRedirect("/contact", "Please enter a valid email address.");
  }
  const message = requireMessageField(form, "/contact");
  if (message instanceof Response) return message;

  // Botpoison is an optional spam-protection layer: when configured the
  // submission must pass verification; otherwise it is accepted as-is.
  if (isBotpoisonEnabled()) {
    const verified = await verifyBotpoisonSolution(
      form.getString(BOTPOISON_FIELD),
    );
    if (!verified) {
      return errorRedirect(
        "/contact",
        "Could not verify your submission. Please try again.",
      );
    }
  }

  const sent = await sendContactMessage(submitter, message);
  if (!sent) return errorRedirect("/contact", MESSAGE_SEND_FAILED);
  return redirect("/contact", "Message sent", true);
};

/** Handle POST /contact - contact form submission. 404 when the form is not
 * active so the endpoint only exists when the feature is fully configured. */
export const handlePublicContactSubmit = (
  request: Request,
): Response | Promise<Response> => {
  if (!isContactFormActive()) return notFoundResponse();
  return requirePublicSite(() =>
    withCsrfForm(
      request,
      (message) => errorRedirect("/contact", message),
      processContactSubmission,
    ),
  );
};
