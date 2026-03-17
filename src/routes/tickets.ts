/**
 * Public ticket view routes - /t/:tokens and /t/:token/svg
 * Displays ticket information for attendees using their ticket tokens.
 * The SVG endpoint serves individual QR codes for CDN caching.
 */

import { signAttachmentUrl } from "#lib/attachment-url.ts";
import { getAllowedDomain } from "#lib/config.ts";
import { decrypt } from "#lib/crypto.ts";
import {
  hasAppleWalletConfig,
  hasGoogleWalletConfig,
} from "#lib/db/settings.ts";
import { generateQrSvg } from "#lib/qr.ts";
import {
  createTokenRoute,
  lookupAttendees,
  resolveEntries,
  type TokenEntry,
  type TokenRouteFn,
} from "#routes/token-utils.ts";
import { htmlResponse, notFoundResponse } from "#routes/utils.ts";
import { type TicketCard, ticketViewPage } from "#templates/tickets.tsx";

/** Build the check-in URL for a single token */
export const buildCheckinUrl = (token: string): string =>
  `https://${getAllowedDomain()}/checkin/${token}`;

/** Build a ticket card for a single token/entry pair */
const buildTicketCard = async (
  entry: TokenEntry,
  token: string,
): Promise<TicketCard> => {
  const { event, attendee } = entry;
  const attachmentUrl = event.attachment_url
    ? await signAttachmentUrl(event.id, attendee.id)
    : undefined;
  return {
    entry,
    token,
    attachmentUrl,
  };
};

/** Handle GET /t/:tokens */
const handleTicketView = async (
  _request: Request,
  tokens: string[],
): Promise<Response> => {
  const result = await lookupAttendees(tokens);
  if (!result.ok) return result.response;

  const [entries, appleWalletEnabled, googleWalletEnabled] = await Promise.all([
    resolveEntries(result.attendees),
    hasAppleWalletConfig(),
    hasGoogleWalletConfig(),
  ]);
  for (const entry of entries) {
    entry.attendee.price_paid = await decrypt(entry.attendee.price_paid);
  }
  const cards = await Promise.all(
    entries.map((entry, index) => buildTicketCard(entry, tokens[index]!)),
  );
  return htmlResponse(
    ticketViewPage(cards, appleWalletEnabled, googleWalletEnabled),
  );
};

/** One year in seconds — SVG tickets never change so cache aggressively */
const ONE_YEAR = 365 * 24 * 60 * 60;

/** Handle GET /t/:token/svg — serve QR code SVG for CDN caching */
const handleTicketSvg = async (token: string): Promise<Response> => {
  const result = await lookupAttendees([token]);
  if (!result.ok) return result.response;

  const svg = await generateQrSvg(buildCheckinUrl(token));
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": `public, max-age=${ONE_YEAR}, immutable`,
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
export const routeTicketView: TokenRouteFn = (request, path, method) => {
  if (method === "GET") {
    const svgToken = matchSvgPath(path);
    if (svgToken) return Promise.resolve(handleTicketSvg(svgToken));
  }
  return tokenRoute(request, path, method);
};
