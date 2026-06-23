/**
 * Route definitions, endpoint handlers, and the routeTicket router
 */

import { htmlResponse, notFoundResponse } from "#routes/response.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import {
  computeGroupSlugIndex,
  getActiveListingsByGroupId,
  getGroupBySlugIndex,
} from "#shared/db/groups.ts";
import { getListingWithCountBySlug } from "#shared/db/listings.ts";
import { getEmailConfig, getHostEmailConfig } from "#shared/email.ts";
import { generateQrSvg } from "#shared/qr.ts";
import { successPage } from "#templates/payment.tsx";
import { handleGroupTicketBySlug } from "./groups.ts";
import { handleQrBookGet } from "./qr-book.ts";
import { anyChildListing, dropChildListings } from "./ticket-payment.ts";
import { handleBySlugs } from "./ticket-submit.ts";
import { parseSlugs } from "./types.ts";

/** Get the email from-address if email is configured. Returns empty string if not. */
export const getFromEmailIfConfigured = async (): Promise<string> => {
  const config = (await getEmailConfig()) ?? getHostEmailConfig();
  return config?.fromAddress ?? "";
};

/** Handle GET /ticket/reserved - reservation success page */
const handleReservedGet = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const tokensParam = url.searchParams.get("tokens");
  const normalizedTokens = tokensParam?.replaceAll(" ", "+") ?? "";
  const tokens = normalizedTokens.split("+").filter((t) => t.length > 0);
  const ticketUrl = tokens.length > 0 ? `/t/${tokens.join("+")}` : null;
  const fromEmail = tokens.length > 0 ? await getFromEmailIfConfigured() : "";

  return htmlResponse(successPage({ fromEmail, ticketUrl }));
};

/**
 * Build a `/ticket` (book) or `/calculate` (quote) slug handler. `mode` drives
 * the whole flow: it picks booking vs quote for the listings lookup, and — for
 * a single slug that 404s (no such listing) — carries through to the group
 * fallback, since the group booking form posts its group slug, not its member
 * slugs.
 */
const slugHandler =
  (mode?: "calculate") =>
  async (request: Request, { slug }: { slug: string }): Promise<Response> => {
    const slugs = parseSlugs(slug);
    const response = await handleBySlugs(request, slugs, mode);
    if (response.status === 404 && slugs.length === 1) {
      return handleGroupTicketBySlug(request, slugs[0]!, mode);
    }
    return response;
  };

/** Handle ticket request: try listings by slugs, fall back to group for single slugs */
const handleTicketBySlug = slugHandler();

/** Handle the `/calculate/<slugs>` running-total POST, with the same group
 * fallback as {@link handleTicketBySlug} but pricing rather than booking. */
const handleCalculateBySlug = slugHandler("calculate");

/** Generate a QR code SVG response for a given slug */
const qrResponse = async (slug: string): Promise<Response> => {
  const ticketUrl = `https://${getEffectiveDomain()}/ticket/${slug}`;
  const svg = await generateQrSvg(ticketUrl);
  return new Response(svg, {
    headers: { "content-type": "image/svg+xml" },
  });
};

/** Handle GET /ticket/:slug/qr (listing first, then group fallback) */
export const handleTicketQrGet = async (
  _request: Request,
  { slug }: { slug: string },
): Promise<Response> => {
  const listing = await getListingWithCountBySlug(slug);
  // A child has no standalone booking page (invariant I3), so its QR — which
  // encodes `/ticket/<child>` — would be a dead end. Suppress it like the rest
  // of the child's share affordances.
  if (listing && (await anyChildListing([listing.id]))) {
    return notFoundResponse();
  }
  if (listing) return qrResponse(slug);

  const slugIndex = await computeGroupSlugIndex(slug);
  const group = await getGroupBySlugIndex(slugIndex);
  // A group QR encodes `/ticket/<group>`, which drops child members (a booking
  // can never start from a child, invariant I3) and 404s when nothing
  // standalone-bookable is left (`renderTicketFlow`). So a group whose only
  // active members are children would mint a guaranteed-dead share link.
  // Apply the same post-child-filter emptiness check here before returning the
  // QR (Fix 3) so the QR 404s exactly when the page it points at would.
  if (group) {
    const members = await getActiveListingsByGroupId(group.id);
    const bookable = await dropChildListings(members);
    return bookable.length === 0 ? notFoundResponse() : qrResponse(slug);
  }

  return notFoundResponse();
};

/** Public ticket routes */
const publicRoutes = defineRoutes({
  "GET /ticket/:slug": handleTicketBySlug,
  "GET /ticket/:slug/qr": handleTicketQrGet,
  "GET /ticket/:slug/qr-book": handleQrBookGet,
  "GET /ticket/reserved": handleReservedGet,
  "POST /calculate/:slug": handleCalculateBySlug,
  "POST /ticket/:slug": handleTicketBySlug,
});

/** Route ticket requests */
export const routeTicket = createRouter(publicRoutes);
