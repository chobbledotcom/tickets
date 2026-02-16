/**
 * Public ticket view routes - /t/:tokens
 * Displays ticket information for attendees using their ticket tokens
 * Includes an inline SVG QR code for each ticket encoding the /checkin/:token URL
 */

import { getAllowedDomain } from "#lib/config.ts";
import { decrypt } from "#lib/crypto.ts";
import { generateQrSvg } from "#lib/qr.ts";
import { ticketViewPage, type TicketCard } from "#templates/tickets.tsx";
import { htmlResponse } from "#routes/utils.ts";
import { createTokenRoute, lookupAttendees, resolveEntries, type TokenEntry } from "#routes/token-utils.ts";

/** Build the check-in URL for a single token */
const buildCheckinUrl = (token: string): string =>
  `https://${getAllowedDomain()}/checkin/${token}`;

/** Build a ticket card with QR code for a single token/entry pair */
const buildTicketCard = async (entry: TokenEntry, token: string): Promise<TicketCard> => ({
  entry,
  qrSvg: await generateQrSvg(buildCheckinUrl(token)),
});

/** Handle GET /t/:tokens */
const handleTicketView = async (_request: Request, tokens: string[]): Promise<Response> => {
  const result = await lookupAttendees(tokens);
  if (!result.ok) return result.response;

  const entries = await resolveEntries(result.attendees);
  for (const entry of entries) {
    entry.attendee.price_paid = await decrypt(entry.attendee.price_paid);
  }
  const cards = await Promise.all(
    entries.map((entry, index) => buildTicketCard(entry, tokens[index]!))
  );
  return htmlResponse(ticketViewPage(cards));
};

/** Route ticket view requests */
export const routeTicketView = createTokenRoute("t", { GET: handleTicketView });
