/**
 * Public pages - home, listings, terms, contact
 */

import { applyFlash, withCsrfForm } from "#routes/csrf.ts";
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
import { getAllGroups } from "#shared/db/groups.ts";
import { settings } from "#shared/db/settings.ts";
import type { FormParams } from "#shared/form-data.ts";
import {
  MESSAGE_SEND_FAILED,
  readMessageSubmission,
} from "#shared/inbound-message.ts";
import { loadSortedListings } from "#shared/sort-listings.ts";
import type { Group, ListingWithCount } from "#shared/types.ts";
import {
  contactPage,
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

/** Process a CSRF-checked contact form submission: validate, run Botpoison
 * verification, and only deliver to the owner when verification passes. */
const processContactSubmission = async (
  form: FormParams,
): Promise<Response> => {
  const submission = readMessageSubmission(form);
  if (!submission.ok) return errorRedirect("/contact", submission.error);
  const { email, message } = submission;

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
