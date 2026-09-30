/** Spread a door's ticket count over a person's booking lines. One person
 * can hold several lines on one listing (two dates, two parents, two
 * packages), so a count names tickets on the listing, never on each line. */

import { remainingTickets } from "#booking/remaining-tickets.ts";
import type { ListingAttendeeRow } from "#db/attendee-types.ts";
import { requiredMapValue, sumOf } from "#fp";

/** Admitting fills lines up to their quantity, releasing empties them. */
export type TicketDirection = "admit" | "release";

/** One person on one listing. */
export type TicketPair = { attendeeId: number; listingId: number };

/** One person's whole booking on one listing: its lines' counts added up. */
export type PairBooking = { checked_in: number; quantity: number };

/** Each (person, listing) pair's whole booking, keyed by `pairKey`. */
export type PairBookings = ReadonlyMap<string, PairBooking>;

/** The person and listing an attendee's booking line belongs to. */
export const linePair = (line: {
  id: number;
  listing_id: number;
}): TicketPair => ({ attendeeId: line.id, listingId: line.listing_id });

/** How many tickets to move for one person on one listing. */
export type TicketMove = TicketPair & { count: number };

/** One move's answer from the write: the tickets it really moved, and what
 * its (person, listing) pair still owes afterwards. */
export type TicketMoveAnswer = TicketMove & { owedAfter: number };

/** One stored booking line, as the write reads it. */
export type StoredTicketLine = Pick<
  ListingAttendeeRow,
  "checked_in" | "listing_id" | "quantity"
> & { attendee_id: number; id: number };

/** The key one (person, listing) pair goes by. */
export const pairKey = (attendeeId: number, listingId: number): string =>
  `${attendeeId}:${listingId}`;

const linePairKey = (line: StoredTicketLine): string =>
  pairKey(line.attendee_id, line.listing_id);

/** Each asked pair's whole booking: its lines' counts added up, or zero for a
 * pair that holds no line the write can move. */
export const pairBookingsOf = (
  pairs: readonly TicketPair[],
  lines: readonly StoredTicketLine[],
): Map<string, PairBooking> => {
  const linesByPair = Map.groupBy(lines, linePairKey);
  return new Map(
    pairs.map(({ attendeeId, listingId }) => {
      const key = pairKey(attendeeId, listingId);
      const pairLines = linesByPair.get(key) ?? [];
      return [
        key,
        {
          checked_in: sumOf((line: StoredTicketLine) => line.checked_in)(
            pairLines,
          ),
          quantity: sumOf((line: StoredTicketLine) => line.quantity)(pairLines),
        },
      ];
    }),
  );
};

/** A line's new admitted count. */
export type ChangedTicketLine = { checked_in: number; id: number };

/** How many tickets one line can still move each way. */
const ROOM: Record<TicketDirection, (line: StoredTicketLine) => number> = {
  admit: remainingTickets,
  release: (line) => line.checked_in,
};

const STEP: Record<TicketDirection, number> = { admit: 1, release: -1 };

/** A ticket count is a whole number of tickets, zero or more. A negative or
 * fractional count would write a torn booking, so the write refuses it. */
const isWholeTicketCount = (count: number): boolean =>
  Number.isSafeInteger(count) && count >= 0;

/** Move each count over the person's lines on that listing in the order
 * given, filling (or emptying) one line before the next. Answers the lines
 * that changed, the tickets each move really moved (less than asked when the
 * lines run out of room), and what each pair still owes afterwards. A count
 * that is not a whole number of tickets throws. */
export const spreadTicketMoves = (
  direction: TicketDirection,
  lines: readonly StoredTicketLine[],
  moves: readonly TicketMove[],
): { changed: ChangedTicketLine[]; moved: TicketMoveAnswer[] } => {
  const bad = moves.find((move) => !isWholeTicketCount(move.count));
  if (bad !== undefined) {
    throw new Error(`Invalid ticket count: ${bad.count}`);
  }
  const after = lines.map((line) => ({ ...line, before: line.checked_in }));
  const moved = moves.map((move) => {
    let left = move.count;
    for (const line of after) {
      if (line.attendee_id !== move.attendeeId) continue;
      if (line.listing_id !== move.listingId) continue;
      const step = Math.min(left, ROOM[direction](line));
      line.checked_in += STEP[direction] * step;
      left -= step;
    }
    return { ...move, count: move.count - left };
  });
  const changed = after
    .filter((line) => line.checked_in !== line.before)
    .map(({ checked_in, id }) => ({ checked_in, id }));
  // What every touched pair still owes after the whole write: the honest
  // remainder for a door that raced another door for the same tickets.
  const bookings = pairBookingsOf(moves, after);
  const movedWithOwed = moved.map((move) => ({
    ...move,
    owedAfter: remainingTickets(
      requiredMapValue(
        bookings,
        pairKey(move.attendeeId, move.listingId),
        `Move for ${pairKey(move.attendeeId, move.listingId)} has no booking`,
      ),
    ),
  }));
  return { changed, moved: movedWithOwed };
};
/** The tickets a set of moves covers in total. */
export const ticketCount: (moves: Iterable<TicketMove>) => number = sumOf(
  (move: TicketMove) => move.count,
);
