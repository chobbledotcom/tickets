/**
 * Public pages - home, listings, terms, contact
 */

import { mapParallel } from "#fp";
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
import { getActiveListingsByGroupId, getAllGroups } from "#shared/db/groups.ts";
import { settings } from "#shared/db/settings.ts";
import type { FormParams } from "#shared/form-data.ts";
import { MESSAGE_SEND_FAILED } from "#shared/inbound-message.ts";
import { loadSortedListings } from "#shared/sort-listings.ts";
import type { Group, ListingWithCount } from "#shared/types.ts";
import { parseEmail } from "#shared/validation/email.ts";
import {
  childCardState,
  contactPage,
  homepagePage,
  type PublicPageType,
  publicSitePage,
} from "#templates/public.tsx";
import {
  applyParentSoldOut,
  classifyForDiscovery,
  groupHasBookableMember,
} from "./discovery.ts";
import { publicNavProps } from "./site-nav.ts";
import { buildTicketListingsWithGroupCapacity } from "./ticket-listings.ts";

/** Active+visible filter for public listing listings */
const isPublicListing = (e: ListingWithCount): boolean => e.active && !e.hidden;

/** Load non-hidden groups that have a member that is actually bookable
 * standalone (see {@link groupHasBookableMember}) — a child-only group's page
 * 404s and a sold-out-parent-only group's page renders no bookable quantity, so
 * either way its `/listings` Book CTA is suppressed rather than a dead link. */
const loadPublicGroups = async (): Promise<Group[]> => {
  const groups = (await getAllGroups()).filter((g) => !g.hidden);
  const bookable = await mapParallel(async (g: Group) =>
    groupHasBookableMember(await getActiveListingsByGroupId(g.id)),
  )(groups);
  return groups.filter((_, i) => bookable[i]);
};

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

/** Handle GET /listings - public listings listing. Shows every active, visible
 * listing alongside the non-hidden groups. (Type filtering lives on the admin
 * listings dashboard, not the public page.) */
export const handlePublicListings = (): Response | Promise<Response> =>
  requirePublicSite(async () => {
    const [groups, { listings }, nav] = await Promise.all([
      loadPublicGroups(),
      loadSortedListings(isPublicListing),
      publicNavProps(null),
    ]);
    // Parents with no bookable child read as sold out; a (visible) child keeps
    // its card but loses its standalone Book CTA (invariants I3/I6).
    const classification = await classifyForDiscovery(listings);
    const ticketListings = applyParentSoldOut(
      await buildTicketListingsWithGroupCapacity(listings),
      classification,
    );
    return htmlResponse(
      homepagePage(
        ticketListings,
        settings.websiteTitle,
        groups,
        childCardState(classification.childIds, classification.addOnChildIds),
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
