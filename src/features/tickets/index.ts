/**
 * Public ticket view routes - /t/:tokens and /t/:token/svg
 * Displays ticket information for attendees using their ticket tokens.
 * The SVG endpoint serves individual QR codes for CDN caching.
 */

import { htmlResponse, notFoundResponse } from "#routes/response.ts";
import {
  createTokenRoute,
  lookupAttendees,
  resolveEntries,
  type TokenEntry,
  type TokenRouteFn,
  withTokenRateLimit,
} from "#routes/tickets/token-utils.ts";
import { signAttachmentUrl } from "#shared/attachment-url.ts";
import { settings } from "#shared/db/settings.ts";
import { generateQrSvg } from "#shared/qr.ts";
import { buildCheckinUrl } from "#shared/ticket-url.ts";
import { type TicketCard, ticketViewPage } from "#templates/tickets.tsx";

/** Build a ticket card for a single token/entry pair */
const buildTicketCard = async (
  entry: TokenEntry,
  token: string,
): Promise<TicketCard> => {
  const attachmentUrl = entry.listing.attachment_url
    ? await signAttachmentUrl(entry.listing.id, entry.attendee.id)
    : undefined;
  return {
    attachmentUrl,
    entry,
    token,
  };
};

/** Handle GET /t/:tokens */
const handleTicketView = async (
  _request: Request,
  tokens: string[],
): Promise<Response> => {
  const result = await lookupAttendees(tokens);
  if (!result.ok) return result.response;

  const entries = await resolveEntries(result.attendees);
  // A quantity-0-only token passes lookupAttendees but resolves to no real
  // entries — treat that as not-found rather than rendering an empty page.
  if (entries.length === 0) return notFoundResponse();
  // With multi-listing, one token maps to multiple entries.
  // Use the first URL token for all cards (it's the same attendee).
  const token = tokens[0]!;
  const cards = await Promise.all(
    entries.map((entry) => buildTicketCard(entry, token)),
  );
  return htmlResponse(
    ticketViewPage(
      cards,
      settings.appleWallet.hasConfig,
      settings.googleWallet.hasConfig,
    ),
  );
};

/** One year in seconds — SVG tickets never change so cache aggressively */
const ONE_YEAR = 365 * 24 * 60 * 60;

/** Handle GET /t/:token/svg — serve QR code SVG for CDN caching */
const handleTicketSvg = async (token: string): Promise<Response> => {
  const result = await lookupAttendees([token]);
  if (!result.ok) return result.response;

  // An all-ghost (no-quantity-only) token resolves to no real entries — don't
  // emit a QR for a ticket that /t and /checkin now treat as not-found.
  const entries = await resolveEntries(result.attendees);
  if (entries.length === 0) return notFoundResponse();

  const svg = await generateQrSvg(buildCheckinUrl(token));
  return new Response(svg, {
    headers: {
      "cache-control": `public, max-age=${ONE_YEAR}, immutable`,
      "content-type": "image/svg+xml",
    },
  });
};

/** Match /t/:token/svg path, returning the token if matched */
const matchSvgPath = (path: string): string | null => {
  const match = path.match(/^\/t\/([^/+]+)\/svg$/);
  return match?.[1] ?? null;
};

/** Token-based route for the regular ticket view */
const tokenRoute = createTokenRoute("t", { GET: handleTicketView });

/** Route ticket view and SVG requests */
export const routeTicketView: TokenRouteFn = (
  request,
  path,
  method,
  server,
) => {
  if (method === "GET") {
    const svgToken = matchSvgPath(path);
    if (svgToken) {
      return withTokenRateLimit(request, server, [svgToken], () =>
        handleTicketSvg(svgToken),
      );
    }
  }
  return tokenRoute(request, path, method, server);
};
