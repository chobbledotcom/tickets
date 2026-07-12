/**
 * Previous bookings for the attendee Contact History panel.
 */

import { compact, unique } from "#fp";
import { attendeeStatuses } from "#shared/db/attendee-statuses.ts";
import {
  type AttendeeBookingRows,
  getAttendeeBookingRowsByTokens,
} from "#shared/db/attendees/tokens.ts";
import { hashEmail, hashPhone } from "#shared/db/contact-preferences.ts";
import { getRecentBookingTokens } from "#shared/db/contact-tokens.ts";
import { getListingNamesByIds } from "#shared/db/listings/records.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { Attendee } from "#shared/types.ts";
import type { PreviousBooking } from "#templates/admin/attendee-page.tsx";

const PREVIOUS_BOOKINGS_LIMIT = 100;
const TOKENS_PER_CHANNEL_LIMIT = PREVIOUS_BOOKINGS_LIMIT * 4;

/** The contact hashes to gather previous bookings from. */
const contactHashesFor = async (attendee: Attendee): Promise<string[]> =>
  Promise.all(
    compact([
      attendee.email.trim() ? hashEmail(attendee.email) : null,
      attendee.phone.trim() ? hashPhone(attendee.phone) : null,
    ]),
  );

const newestTokensForChannel = (
  tokens: { token: string }[],
  currentToken: string,
): string[] =>
  tokens
    .map((entry) => entry.token)
    .filter((token) => token !== currentToken)
    .slice(-TOKENS_PER_CHANNEL_LIMIT)
    .reverse();

const cappedTokensFor = (
  tokenLists: { token: string }[][],
  currentToken: string,
): string[] =>
  unique(
    tokenLists.flatMap((tokens) =>
      newestTokensForChannel(tokens, currentToken),
    ),
  );

const listingIdsFor = (bookings: AttendeeBookingRows[]): number[] =>
  unique(
    bookings.flatMap((booking) =>
      booking.bookings.map((line) => line.listing_id),
    ),
  );

/** Build one Previous bookings row from already-loaded booking rows. */
const previousBookingRow = (
  booked: AttendeeBookingRows,
  statusNameById: Map<number, string>,
  listingNameById: Map<number, string>,
): PreviousBooking => ({
  attendeeId: booked.id,
  created: booked.created,
  items: booked.bookings.map((line) => ({
    name: listingNameById.get(line.listing_id)!,
    quantity: line.quantity,
  })),
  statusName: statusNameById.get(booked.status_id ?? -1) ?? null,
  totalValue: booked.bookings.reduce((sum, line) => sum + line.price_paid, 0),
});

/**
 * Load the other bookings this contact has made.
 *
 * The table is deliberately a shown-history preview, not an unbounded audit:
 * each contact channel contributes only its newest token window, empty/no-real
 * bookings are dropped before the display cap, and the rows are resolved
 * without selecting attendee PII.
 */
export const loadPreviousBookings = async (
  attendee: Attendee,
): Promise<PreviousBooking[]> => {
  const hashes = await contactHashesFor(attendee);
  if (hashes.length === 0) return [];
  const privateKey = await requireRequestPrivateKey();
  const tokenLists = await Promise.all(
    hashes.map((hash) =>
      getRecentBookingTokens(hash, privateKey, TOKENS_PER_CHANNEL_LIMIT),
    ),
  );
  const tokens = cappedTokensFor(tokenLists, attendee.ticket_token);
  if (tokens.length === 0) return [];

  const resolved = compact(await getAttendeeBookingRowsByTokens(tokens)).filter(
    (booking) => booking.bookings.length > 0,
  );
  if (resolved.length === 0) return [];

  const [statuses, listingNameById] = await Promise.all([
    attendeeStatuses.getAll(),
    getListingNamesByIds(listingIdsFor(resolved)),
  ]);
  const statusNameById = new Map(
    statuses.map((status) => [status.id, status.name]),
  );

  return resolved
    .map((booked) =>
      previousBookingRow(booked, statusNameById, listingNameById),
    )
    .sort((left, right) => right.created.localeCompare(left.created))
    .slice(0, PREVIOUS_BOOKINGS_LIMIT);
};
