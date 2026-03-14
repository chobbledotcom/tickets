/**
 * Shared utilities for token-based routes (/t/:tokens and /checkin/:tokens)
 */

import { compact, map } from "#fp";
import { getAllowedDomain } from "#lib/config.ts";
import { decrypt } from "#lib/crypto.ts";
import { getAttendeesByTokens } from "#lib/db/attendees.ts";
import { getEventWithCount } from "#lib/db/events.ts";
import { getCurrencyCodeFromDb } from "#lib/db/settings.ts";
import type { Attendee, EventWithCount } from "#lib/types.ts";
import { notFoundResponse } from "#routes/utils.ts";

/** Attendee paired with its event */
export type TokenEntry = {
  attendee: Attendee;
  event: EventWithCount;
};

/** Shared wallet pass data common to both Apple and Google Wallet */
export type WalletPassData = {
  serialNumber: string;
  organizationName: string;
  eventName: string;
  eventDate: string;
  eventLocation: string;
  attendeeDate: string | null;
  quantity: number;
  pricePaid: number;
  currencyCode: string;
  checkinUrl: string;
};

/** Cache wallet responses for 1 hour on CDN, 5 minutes in browser */
export const WALLET_CACHE_CONTROL = "public, max-age=300, s-maxage=3600";

/** Build shared wallet pass data from a resolved token entry */
export const buildWalletPassData = async (
  entry: TokenEntry,
  token: string,
): Promise<WalletPassData> => {
  const { event, attendee } = entry;
  const domain = getAllowedDomain();
  const currencyCode = await getCurrencyCodeFromDb();
  const pricePaid = Number(await decrypt(attendee.price_paid));

  return {
    serialNumber: token,
    organizationName: domain,
    eventName: event.name,
    eventDate: event.date,
    eventLocation: event.location,
    attendeeDate: attendee.date,
    quantity: attendee.quantity,
    pricePaid,
    currencyCode,
    checkinUrl: `https://${domain}/checkin/${token}`,
  };
};

/** Result of looking up a single token's wallet pass data */
export type SingleTokenResult =
  | { ok: true; passData: WalletPassData }
  | { ok: false; response: Response };

/** Look up a single token and build wallet pass data, returning 404 on failure */
export const lookupSingleTokenPassData = async (
  tokens: string[],
): Promise<SingleTokenResult> => {
  const token = tokens[0];
  if (!token || tokens.length > 1)
    return { ok: false, response: notFoundResponse() };

  const result = await lookupAttendees([token]);
  if (!result.ok) return { ok: false, response: result.response };

  const entries = await resolveEntries(result.attendees);
  const passData = await buildWalletPassData(entries[0]!, token);
  return { ok: true, passData };
};

/** Handler type for token-based route methods */
type TokenMethodHandler = (
  request: Request,
  tokens: string[],
) => Promise<Response>;

/** Map of HTTP method to handler */
type TokenMethodMap = Record<string, TokenMethodHandler>;

/** Extract the token segment from a path like /prefix/tokens */
export const extractTokenSegment = (
  prefix: string,
  path: string,
): string | null => {
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
export const lookupAttendees = async (
  tokens: string[],
): Promise<TokenLookupResult> => {
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
export const createTokenRoute =
  (prefix: string, methods: TokenMethodMap) =>
  (
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
