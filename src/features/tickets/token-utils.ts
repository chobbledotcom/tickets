/**
 * Shared utilities for token-based routes (/t/:tokens and /checkin/:tokens)
 */

import { compact, unique } from "#fp";
import { notFoundResponse, rateLimitedResponse } from "#routes/response.ts";
import type { PathMethodRoute, ServerContext } from "#routes/types.ts";
import { getClientIp } from "#routes/url.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import {
  type AttendeeWithBookings,
  decryptAttendees,
  type EventAttendeeRow,
  getAttendeesByTokens,
} from "#shared/db/attendees.ts";
import { getEventWithCount } from "#shared/db/events.ts";
import { settings } from "#shared/db/settings.ts";
import {
  clearTokenAttempts,
  isTokenRateLimited,
  recordTokenFailure,
} from "#shared/db/token-attempts.ts";
import { addPendingWork } from "#shared/pending-work.ts";
import { buildCheckinUrl } from "#shared/ticket-url.ts";
import type { Attendee, EventWithCount } from "#shared/types.ts";

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
export const buildWalletPassData = (
  entry: TokenEntry,
  token: string,
): WalletPassData => {
  const { event, attendee } = entry;
  const domain = getEffectiveDomain();
  return {
    attendeeDate: attendee.date,
    checkinUrl: buildCheckinUrl(token),
    currencyCode: settings.currency,
    eventDate: event.date,
    eventLocation: event.location,
    eventName: event.name,
    organizationName: domain,
    pricePaid: Number(attendee.price_paid),
    quantity: attendee.quantity,
    serialNumber: token,
  };
};

/** Result of looking up a single token's wallet pass data */
export type SingleTokenResult =
  | { ok: true; passData: WalletPassData }
  | { ok: false; response: Response };

/** Look up a single token and build wallet pass data, returning 404 on failure.
 * For multi-event attendees, returns the first event's pass data. */
export const lookupSingleTokenPassData = async (
  tokens: string[],
): Promise<SingleTokenResult> => {
  const token = tokens[0];
  if (!token || tokens.length > 1) {
    return { ok: false, response: notFoundResponse() };
  }

  const result = await lookupAttendees([token]);
  if (!result.ok) return { ok: false, response: result.response };

  const entries = await resolveEntries(result.attendees);
  const entry = entries[0];
  if (!entry) return { ok: false, response: notFoundResponse() };
  return { ok: true, passData: buildWalletPassData(entry, token) };
};

/** Route function signature for token-based routes */
export type TokenRouteFn = PathMethodRoute;

/** Handler type for token-based route methods */
type TokenMethodHandler = (
  request: Request,
  tokens: string[],
) => Response | Promise<Response>;

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

/** Parse +-separated tokens from a combined string, removing duplicates */
export const parseTokens = (tokensStr: string): string[] =>
  unique(tokensStr.split("+").filter((s) => s.length > 0));

/** Build an Attendee object from base attendee data + one booking's per-event data */
const buildAttendeeView = (
  base: AttendeeWithBookings,
  booking: EventAttendeeRow,
): Attendee => ({
  address: "",
  attachment_downloads: booking.attachment_downloads,
  checked_in: booking.checked_in === 1,
  created: base.created,
  date: booking.start_at ? booking.start_at.slice(0, 10) : null,
  email: "",
  event_id: booking.event_id,
  id: base.id,
  name: "",
  payment_id: "",
  phone: "",
  pii_blob: base.pii_blob,
  price_paid: String(booking.price_paid),
  quantity: booking.quantity,
  refunded: booking.refunded === 1,
  special_instructions: "",
  ticket_token: base.ticket_token,
  ticket_token_index: base.ticket_token_index,
});

/**
 * Resolve attendees with bookings to token entries.
 * Expands each attendee × booking into a separate TokenEntry.
 * Events are batch-fetched via cache (getEventWithCount).
 */
export const resolveEntries = async (
  attendeesWithBookings: AttendeeWithBookings[],
): Promise<TokenEntry[]> => {
  // Collect all event IDs and batch-fetch (getEventWithCount is cached)
  const allEventIds = unique(
    attendeesWithBookings.flatMap((a) => a.bookings.map((b) => b.event_id)),
  );
  const events = new Map<number, EventWithCount>();
  await Promise.all(
    allEventIds.map(async (id) => {
      const event = await getEventWithCount(id);
      if (event) events.set(id, event);
    }),
  );

  // Expand each attendee × booking into a TokenEntry
  const entries: TokenEntry[] = [];
  for (const awb of attendeesWithBookings) {
    for (const booking of awb.bookings) {
      const event = events.get(booking.event_id);
      if (event) {
        entries.push({
          attendee: buildAttendeeView(awb, booking),
          event,
        });
      }
    }
  }
  return entries;
};

/** Decrypt PII in token entries' attendees using the given private key */
export const decryptTokenEntries = async (
  entries: TokenEntry[],
  privateKey: CryptoKey,
): Promise<TokenEntry[]> => {
  const decrypted = await decryptAttendees(
    entries.map((e) => e.attendee),
    privateKey,
  );
  return entries.map((e, i) => ({ ...e, attendee: decrypted[i]! }));
};

/** Result of looking up attendees by tokens - either valid data or a 404 response */
export type TokenLookupResult =
  | { ok: true; attendees: AttendeeWithBookings[] }
  | { ok: false; response: Response };

/** Look up attendees by tokens, returning 404 if none found */
export const lookupAttendees = async (
  tokens: string[],
): Promise<TokenLookupResult> => {
  const results = await getAttendeesByTokens(tokens);
  const valid = compact(results);
  return valid.length === 0
    ? { ok: false, response: notFoundResponse() }
    : { attendees: valid, ok: true };
};

/**
 * Run a token handler under rate-limit protection: returns 429 if the IP is
 * currently locked out, otherwise runs the handler, recording a failure on
 * 404 or clearing prior failure state on 2xx (successful token lookups don't
 * contribute to the limit and also wipe the IP's fat-finger history).
 */
export const withTokenRateLimit = async (
  request: Request,
  server: ServerContext | undefined,
  tokens: string[],
  run: () => Response | Promise<Response>,
): Promise<Response> => {
  const ip = getClientIp(request, server);
  if (await isTokenRateLimited(ip)) return rateLimitedResponse();

  const response = await run();
  if (response.status === 404 && tokens.length > 0) {
    addPendingWork(recordTokenFailure(ip, tokens));
  } else if (response.ok) {
    addPendingWork(clearTokenAttempts(ip));
  }
  return response;
};

/**
 * Create a token-based route handler for a given URL prefix.
 * Extracts tokens from the path, dispatches to method handlers, and applies
 * 404-based rate limiting per client IP.
 */
export const createTokenRoute =
  (prefix: string, methods: TokenMethodMap): TokenRouteFn =>
  (request, path, method, server) => {
    const tokensStr = extractTokenSegment(prefix, path);
    if (!tokensStr) return Promise.resolve(null);

    const handler = methods[method];
    if (!handler) return Promise.resolve(null);

    const tokens = parseTokens(tokensStr);
    return withTokenRateLimit(request, server, tokens, () =>
      handler(request, tokens),
    );
  };
