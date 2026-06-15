/**
 * Public pages - home, listings, terms, contact
 */

import { unique } from "#fp";
import { applyFlash, withCsrfForm } from "#routes/csrf.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirect,
  redirectResponse,
} from "#routes/response.ts";
import { getSearchParam } from "#routes/url.ts";
import { BOTPOISON_FIELD, verifyBotpoisonSolution } from "#shared/botpoison.ts";
import { isBotpoisonEnabled } from "#shared/config.ts";
import {
  contactFormPublicKey,
  isContactFormActive,
  sendContactMessage,
} from "#shared/contact-form.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { getAllGroups } from "#shared/db/groups.ts";
import { settings } from "#shared/db/settings.ts";
import type { FormParams } from "#shared/form-data.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { loadSortedListings } from "#shared/sort-listings.ts";
import type { Group, ListingWithCount } from "#shared/types.ts";
import { isValidEmail } from "#shared/validation/email.ts";
import {
  contactPage,
  homepagePage,
  isListingFilter,
  type ListingFilter,
  type PublicPageType,
  publicSitePage,
} from "#templates/public.tsx";
import { buildTicketListingsWithGroupCapacity } from "./ticket-listings.ts";

/** Active+visible filter for public listing listings */
const isPublicListing = (e: ListingWithCount): boolean => e.active && !e.hidden;

/** The type category a listing falls under for the public listings filter. */
const listingCategory = (e: ListingWithCount): ListingFilter =>
  e.purchase_only
    ? "purchase-only"
    : e.listing_type === "daily"
      ? "daily"
      : "standard";

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

/** Handle GET /listings - public listings listing, optionally filtered by type
 * via `?filter=standard|daily|purchase-only`. Groups are shown only on the
 * unfiltered ("all") view since they aren't a listing type. */
export const handlePublicListings = (
  request: Request,
): Response | Promise<Response> =>
  requirePublicSite(async () => {
    const [groups, { listings }] = await Promise.all([
      loadPublicGroups(),
      loadSortedListings(isPublicListing),
    ]);
    const raw = getSearchParam(request, "filter");
    const active: ListingFilter = isListingFilter(raw) ? raw : "all";
    const categories = unique(listings.map(listingCategory));
    const shown =
      active === "all"
        ? listings
        : listings.filter((e) => listingCategory(e) === active);
    const ticketListings = await buildTicketListingsWithGroupCapacity(shown);
    return htmlResponse(
      homepagePage(
        ticketListings,
        settings.websiteTitle,
        active === "all" ? groups : [],
        { active, categories },
      ),
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
      error: flash.error,
      formActive,
      success: flash.success,
      websiteTitle: settings.websiteTitle,
    }),
  );
};

/** Handle GET /contact - public contact page (404 when empty and form off) */
export const handlePublicContact = (
  request: Request,
): Response | Promise<Response> =>
  requirePublicSite(() => renderContactPage(request));

/** Validate submitted contact fields. Returns an error message or null. */
const validateContactSubmission = (
  email: string,
  message: string,
): string | null => {
  if (!isValidEmail(email)) {
    return "Please enter a valid email address.";
  }
  if (!message) return "Please enter a message.";
  if (message.length > MAX_TEXTAREA_LENGTH) {
    return `Message must be ${MAX_TEXTAREA_LENGTH} characters or fewer.`;
  }
  return null;
};

/** Process a CSRF-checked contact form submission: validate, run Botpoison
 * verification, and only deliver to the owner when verification passes. */
const processContactSubmission = async (
  form: FormParams,
): Promise<Response> => {
  const email = form.getString("email");
  const message = form.getString("message");

  const validationError = validateContactSubmission(email, message);
  if (validationError) return errorRedirect("/contact", validationError);

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

  const sent = await sendContactMessage(email, message);
  if (!sent) {
    return errorRedirect(
      "/contact",
      "Sorry, your message could not be sent. Please try again later.",
    );
  }
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
