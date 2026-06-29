/**
 * Route definitions, endpoint handlers, and the routeTicket router
 */

import { htmlResponse, notFoundResponse } from "#routes/response.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import { verifyTokensWithRealLine } from "#routes/tickets/token-utils.ts";
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
import { groupBookable } from "./discovery.ts";
import { handleGroupTicketBySlug } from "./groups.ts";
import { handleQrBookGet } from "./qr-book.ts";
import { anyChildListing } from "./ticket-payment.ts";
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
  // Resolve and filter the tokens (like /payment/success): only show the
  // "booking confirmed" CTA when a real (quantity > 0) line exists, so a
  // stale/crafted no-quantity-only token doesn't link to a /t URL that 404s.
  const { verifiedTokens } = await verifyTokensWithRealLine(tokens);
  const ticketUrl =
    verifiedTokens.length > 0 ? `/t/${verifiedTokens.join("+")}` : null;
  const fromEmail = ticketUrl ? await getFromEmailIfConfigured() : "";

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
  // A group QR encodes `/ticket/<group>`, which renders no bookable quantity
  // when the group has no standalone-bookable member — every member is a child
  // (a booking can never start from a child, invariant I3) or a parent projected
  // sold out (its required children all unavailable). For a PACKAGE the whole
  // bundle must fit. Use the SAME gate as the `/listings` group CTA so the QR
  // 404s exactly when the page it points at would offer nothing to book.
  if (group) {
    const members = await getActiveListingsByGroupId(group.id);
    return (await groupBookable(group, members))
      ? qrResponse(slug)
      : notFoundResponse();
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
