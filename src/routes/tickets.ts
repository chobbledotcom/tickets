/**
 * Public ticket view routes - /t/:tokens
 * Displays ticket information for attendees using their ticket tokens
 * Includes an inline SVG QR code encoding the /checkin/:tokens URL
 */

import { getAllowedDomain } from "#lib/config.ts";
import { generateQrSvg } from "#lib/qr.ts";
import { ticketViewPage } from "#templates/tickets.tsx";
import { htmlResponse } from "#routes/utils.ts";
import { createTokenRoute, lookupAttendees, resolveEntries } from "#routes/token-utils.ts";

/** Build the check-in URL for QR code */
const buildCheckinUrl = (tokens: string[]): string =>
  `https://${getAllowedDomain()}/checkin/${tokens.join("+")}`;

/** Handle GET /t/:tokens */
const handleTicketView = async (_request: Request, tokens: string[]): Promise<Response> => {
  const result = await lookupAttendees(tokens);
  if (!result.ok) return result.response;

  const entries = await resolveEntries(result.attendees);
  const qrSvg = await generateQrSvg(buildCheckinUrl(tokens));
  return htmlResponse(ticketViewPage(entries, qrSvg));
};

/** Route ticket view requests */
export const routeTicketView = createTokenRoute("t", { GET: handleTicketView });
