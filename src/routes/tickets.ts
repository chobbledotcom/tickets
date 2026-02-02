/**
 * Public ticket view routes - /t/:tokens
 * Displays ticket information for attendees using their ticket tokens
 */

import { compact, map } from "#fp";
import { getAttendeesByTokens } from "#lib/db/attendees.ts";
import { getEventWithCount } from "#lib/db/events.ts";
import type { Attendee } from "#lib/types.ts";
import type { TicketEntry } from "#templates/tickets.tsx";
import { ticketViewPage } from "#templates/tickets.tsx";
import { htmlResponse, notFoundResponse } from "#routes/utils.ts";

/** Pattern to extract tokens from /t/... path */
const TOKENS_PATTERN = /^\/t\/(.+)$/;

/** Extract tokens string from path */
const extractTokensFromPath = (path: string): string | null => {
  const match = path.match(TOKENS_PATTERN);
  return match?.[1] ?? null;
};

/** Parse +-separated tokens from a combined string */
const parseTokens = (tokensStr: string): string[] =>
  tokensStr.split("+").filter((s) => s.length > 0);

/** Look up the event for an attendee and pair them */
const resolveEntry = async (attendee: Attendee): Promise<TicketEntry> => {
  const event = (await getEventWithCount(attendee.event_id))!;
  return { attendee, event };
};

/** Resolve all attendees to ticket entries */
const resolveEntries = (attendees: Attendee[]): Promise<TicketEntry[]> =>
  Promise.all(map(resolveEntry)(attendees));

/** Handle GET /t/:tokens */
const handleTicketView = async (tokens: string[]): Promise<Response> => {
  const attendees = await getAttendeesByTokens(tokens);
  const validAttendees = compact(attendees);

  if (validAttendees.length === 0) {
    return notFoundResponse();
  }

  const entries = await resolveEntries(validAttendees);
  return htmlResponse(ticketViewPage(entries));
};

/** Route ticket view requests */
export const routeTicketView = (
  _request: Request,
  path: string,
  method: string,
): Promise<Response | null> => {
  const tokensStr = extractTokensFromPath(path);
  if (!tokensStr) return Promise.resolve(null);

  if (method !== "GET") return Promise.resolve(null);

  const tokens = parseTokens(tokensStr);
  return handleTicketView(tokens);
};
