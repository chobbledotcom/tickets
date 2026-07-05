/**
 * Public ticket view routes - /t/:tokens and /t/:token/svg
 * Displays ticket information for attendees using their ticket tokens.
 * The SVG endpoint serves individual QR codes for CDN caching.
 */

import { htmlResponse, notFoundResponse } from "#routes/response.ts";
import {
  createTokenRoute,
  lookupAttendees,
  packageDisplaysForEntries,
  resolveEntries,
  type TokenEntry,
  type TokenRouteFn,
  withTokenRateLimit,
} from "#routes/tickets/token-utils.ts";
import { signAttachmentUrl } from "#shared/attachment-url.ts";
import { computeTicketTokenIndex } from "#shared/crypto/hashing.ts";
import { settings } from "#shared/db/settings.ts";
import { generateQrSvg } from "#shared/qr.ts";
import { buildCheckinUrl } from "#shared/ticket-url.ts";
import { type TicketCard, ticketViewPage } from "#templates/tickets.tsx";

/** Build a ticket card for one entry, keyed by that entry's OWN token. Keying on
 * the row's real token (not the URL's first token) keeps a multi-token page's
 * distinct attendees on distinct cards/QRs and lets package collapsing bucket by
 * (token, package) without merging two attendees. This view doesn't decrypt, so
 * the token is re-derived from the URL by index rather than read off the
 * attendee (whose `ticket_token` is only populated after decryption). */
const buildTicketCard = async (
  entry: TokenEntry,
  token: string,
): Promise<TicketCard> => {
  const attachmentUrl = entry.listing.attachment_url
    ? await signAttachmentUrl(entry.listing.id, entry.attendee.id)
    : undefined;
  return {
    ...(attachmentUrl !== undefined ? { attachmentUrl } : {}),
    entry,
    token,
  };
};

/** Curry a ticket handler over the shared preamble: look the tokens up, drop
 * no-quantity ghost lines, and 404 when nothing real is left, then hand the real
 * entries and tokens to `render`. */
const withResolvedEntries =
  (render: (entries: TokenEntry[], tokens: string[]) => Promise<Response>) =>
  async (_request: Request, tokens: string[]): Promise<Response> => {
    const result = await lookupAttendees(tokens);
    if (!result.ok) return result.response;
    const entries = await resolveEntries(result.attendees);
    if (entries.length === 0) return notFoundResponse();
    return render(entries, tokens);
  };

/** Handle GET /t/:tokens. One token can map to several cards (multi-listing);
 * they share the first URL token (same attendee). */
const handleTicketView = withResolvedEntries(async (entries, tokens) => {
  // This view doesn't decrypt, so each resolved attendee carries only its token
  // INDEX. Map every URL token to its index, then re-attach the matching token to
  // each card so cards key by their real token.
  const tokenByIndex = new Map(
    await Promise.all(
      tokens.map(async (t) => [await computeTicketTokenIndex(t), t] as const),
    ),
  );
  const cards = await Promise.all(
    entries.map((entry) =>
      buildTicketCard(
        entry,
        tokenByIndex.get(entry.attendee.ticket_token_index)!,
      ),
    ),
  );
  // Collapse each package's rows into one card (members grouped, or hidden),
  // keyed by (token, package). Each card carries its own attendee token, so a
  // multi-token URL (`/t/a+b`) keeps distinct attendees' cards — and check-in
  // QRs — separate while still collapsing each package. Disabling collapsing for
  // multi-token pages would render a hidden package's member rows as normal cards
  // and leak the concealed names, so it is always enabled.
  const packageDisplays = await packageDisplaysForEntries(entries);
  return htmlResponse(
    ticketViewPage(
      cards,
      settings.appleWallet.hasConfig,
      settings.googleWallet.hasConfig,
      packageDisplays,
    ),
  );
});

/** One year in seconds — SVG tickets never change so cache aggressively */
const ONE_YEAR = 365 * 24 * 60 * 60;

/** Handle GET /t/:token/svg — serve QR code SVG for CDN caching */
const handleTicketSvg = withResolvedEntries(async (_entries, tokens) => {
  const svg = await generateQrSvg(buildCheckinUrl(tokens[0]!));
  return new Response(svg, {
    headers: {
      "cache-control": `public, max-age=${ONE_YEAR}, immutable`,
      "content-type": "image/svg+xml",
    },
  });
});

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
        handleTicketSvg(request, [svgToken]),
      );
    }
  }
  return tokenRoute(request, path, method, server);
};
