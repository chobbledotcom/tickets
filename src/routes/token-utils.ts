/**
 * Shared utilities for token-based routes (/t/:tokens and /checkin/:tokens)
 */

import { compact, map } from "#fp";
import { getAttendeesByTokens } from "#lib/db/attendees.ts";
import { getEventWithCount } from "#lib/db/events.ts";
import type { Attendee, EventWithCount } from "#lib/types.ts";
import { notFoundResponse } from "#routes/utils.ts";

/** Attendee paired with its event */
export type TokenEntry = {
  attendee: Attendee;
  event: EventWithCount;
};

/** Handler type for token-based route methods */
type TokenMethodHandler = (request: Request, tokens: string[]) => Promise<Response>;

/** Map of HTTP method to handler */
type TokenMethodMap = Record<string, TokenMethodHandler>;

/** Extract the token segment from a path like /prefix/tokens */
export const extractTokenSegment = (prefix: string, path: string): string | null => {
  const pattern = new RegExp(`^/${prefix}/(.+)$`);
  const match = path.match(pattern);
  return match?.[1] ?? null;
};

/** Parse +-separated tokens from a combined string */
export const parseTokens = (tokensStr: string): string[] =>
  tokensStr.split("+").filter((s) => s.length > 0);

/** Look up the event for an attendee and pair them */
const resolveEntry = async (attendee: Attendee): Promise<TokenEntry> => {
  const event = (await getEventWithCount(attendee.event_id))!;
  return { attendee, event };
};

/** Resolve all attendees to entries with their events */
export const resolveEntries = (attendees: Attendee[]): Promise<TokenEntry[]> =>
  Promise.all(map(resolveEntry)(attendees));

/** Result of looking up attendees by tokens - either valid attendees or a 404 response */
export type TokenLookupResult =
  | { ok: true; attendees: Attendee[] }
  | { ok: false; response: Response };

/** Look up attendees by tokens, returning 404 if none found */
export const lookupAttendees = async (tokens: string[]): Promise<TokenLookupResult> => {
  const attendees = await getAttendeesByTokens(tokens);
  const valid = compact(attendees);
  return valid.length === 0
    ? { ok: false, response: notFoundResponse() }
    : { ok: true, attendees: valid };
};

/**
 * Create a token-based route handler for a given URL prefix.
 * Extracts tokens from the path, dispatches to method handlers.
 */
export const createTokenRoute = (
  prefix: string,
  methods: TokenMethodMap,
) => (
  request: Request,
  path: string,
  method: string,
): Promise<Response | null> => {
  const tokensStr = extractTokenSegment(prefix, path);
  if (!tokensStr) return Promise.resolve(null);

  const handler = methods[method];
  if (!handler) return Promise.resolve(null);

  return handler(request, parseTokens(tokensStr));
};
