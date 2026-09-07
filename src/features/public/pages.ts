/**
 * Public pages - home, listings, terms, contact
 */

import { getSelectedAttributesForListings } from "#db/attributes.ts";
import { settings } from "#db/settings.ts";
/* jscpd:ignore-start */
import { requireMessageField, withCsrfForm } from "#routes/csrf.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
import { BOTPOISON_FIELD, verifyBotpoisonSolution } from "#shared/botpoison.ts";
import { getBotpoisonPublicKey, isBotpoisonEnabled } from "#shared/config.ts";
import {
  isContactFormActive,
  sendContactMessage,
} from "#shared/contact-form.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { parseIsoDateParam } from "#shared/dates.ts";
import type { FormParams } from "#shared/form-data.ts";
import { MESSAGE_SEND_FAILED } from "#shared/inbound-message.ts";
import { isPublicListing } from "#shared/listing-visibility.ts";
import { requirePublicSite } from "#shared/public-site.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import { loadSortedListings } from "#shared/sort-listings.ts";
import { parseEmail } from "#shared/validation/email.ts";
import {
  contactPage,
  type PublicPageType,
  publicSitePage,
} from "#templates/public/basic-pages.tsx";
import {
  childCardState,
  type DailyDateFilter,
  homepagePage,
} from "#templates/public/homepage.tsx";
import type { GroupWithMembers, ListingWithCount } from "#types";
import { applyParentSoldOut, classifyForDiscovery } from "./discovery.ts";
import { loadPublicGroups } from "./group-liveness.ts";
import { loadDailyDateAvailability } from "./listing-date-availability.ts";
import { publicNavProps } from "./site-nav.ts";
import { buildTicketListingsWithGroupCapacity } from "./ticket-listings.ts";

/* jscpd:ignore-end */

/** Render a public site page with website title and content */
const renderPublicPage: ResponseHandler<
  [pageType: PublicPageType, getContent: () => string | null]
> = (pageType, getContent) =>
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
export const handleHome: ResponseHandler = () =>
  renderPublicPage("home", () => settings.homepageText);

/** A package is bought as one whole bundle, so one member that cannot be booked
 * on the chosen date makes the whole bundle unbookable. The date availability
 * itself is resolved once for the whole page in
 * {@link loadDailyDateAvailability}; this is the projection of that result. */
const soldOutPackageIds = (
  groups: readonly GroupWithMembers[],
  unavailableIds: ReadonlySet<number>,
): ReadonlySet<number> =>
  new Set(
    groups
      .filter(
        ({ group, members }) =>
          group.is_package &&
          members.some(
            (member) =>
              member.listing_type === "daily" && unavailableIds.has(member.id),
          ),
      )
      .map(({ group }) => group.id),
  );

/** The /listings date filter (#51): present whenever daily cards are on the
 * page (so the form renders and invites a date), with per-listing unavailable
 * ids resolved date-aware once a date is chosen. A daily listing's capacity is
 * a per-date fact, so the cards claim nothing until the visitor picks one. */
const dailyDateFilter = (
  listings: readonly ListingWithCount[],
  unavailableIds: ReadonlySet<number>,
  requestedDate: string | null,
): DailyDateFilter | null =>
  listings.some((e) => e.listing_type === "daily")
    ? { date: requestedDate, unavailableIds }
    : null;

/** Handle GET /listings - public listings listing. Shows every active, visible
 * listing alongside the non-hidden groups. (Type filtering lives on the admin
 * listings dashboard, not the public page.) When daily listings are shown, a
 * `?date=` filter resolves their per-date availability (#51), and any package
 * with any member unavailable on that date reads as sold out too. */
export const handlePublicListings: ResponseHandler<[request: Request]> = (
  request,
) =>
  requirePublicSite(async () => {
    const [publicGroups, { listings, holidays }, nav] = await Promise.all([
      loadPublicGroups(),
      loadSortedListings(isPublicListing),
      publicNavProps(null),
    ]);
    // Parents with no bookable child read as sold out; a (visible) child keeps
    // its card but loses its standalone Book CTA (invariants I3/I6).
    const classification = await classifyForDiscovery(listings);
    const requestedDate = parseIsoDateParam(
      new URL(request.url).searchParams.get("date"),
    );
    // One capacity snapshot answers both the dated cards and the package
    // sold-out badges: daily cards and package members share the read.
    const unavailableOnDate =
      requestedDate === null
        ? new Set<number>()
        : await loadDailyDateAvailability(
            [
              ...listings.filter((e) => e.listing_type === "daily"),
              ...publicGroups.flatMap(({ members }) => members),
            ],
            requestedDate,
            holidays,
          );
    const groups = publicGroups.map(({ group }) => group);
    const [ticketListings, attributesByListing] = await Promise.all([
      buildTicketListingsWithGroupCapacity(listings),
      getSelectedAttributesForListings(listings.map((listing) => listing.id)),
    ]);
    const soldOutPackages = soldOutPackageIds(publicGroups, unavailableOnDate);
    return htmlResponse(
      homepagePage(
        applyParentSoldOut(ticketListings, classification),
        settings.websiteTitle,
        groups,
        childCardState(
          classification.nonStandaloneChildIds,
          classification.addOnChildIds,
        ),
        dailyDateFilter(listings, unavailableOnDate, requestedDate),
        nav,
        soldOutPackages,
        requestedDate,
        attributesByListing,
      ),
    );
  });

/** Handle GET /terms - public terms and conditions page (404 when empty) */
export const handlePublicTerms: ResponseHandler = () =>
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
const renderContactPage = async (): Promise<Response> => {
  const formActive = isContactFormActive();
  if (!settings.contactPageText && !formActive) return notFoundResponse();
  if (formActive) await signCsrfToken();
  return htmlResponse(
    contactPage({
      botpoisonPublicKey: getBotpoisonPublicKey(),
      content: settings.contactPageText || null,
      formActive,
      nav: await publicNavProps(null),
      websiteTitle: settings.websiteTitle,
    }),
  );
};

/** Handle GET /contact - public contact page (404 when empty and form off) */
export const handlePublicContact: ResponseHandler<[request: Request]> = () =>
  requirePublicSite(renderContactPage);

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
export const handlePublicContactSubmit: ResponseHandler<[request: Request]> = (
  request,
) => {
  if (!isContactFormActive()) return notFoundResponse();
  return requirePublicSite(() =>
    withCsrfForm(
      request,
      (message) => errorRedirect("/contact", message),
      processContactSubmission,
    ),
  );
};
