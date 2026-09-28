/** Spread a door's ticket count over a person's booking lines. One person
 * can hold several lines on one listing (two dates, two parents, two
 * packages), so a count names tickets on the listing, never on each line. */

import { remainingTickets } from "#booking/remaining-tickets.ts";
import type { ListingAttendeeRow } from "#db/attendee-types.ts";
import { sumOf } from "#fp";

/** Admitting fills lines up to their quantity, releasing empties them. */
export type TicketDirection = "admit" | "release";

/** How many tickets to move for one person on one listing. */
export type TicketMove = {
  attendeeId: number;
  count: number;
  listingId: number;
};

/** One move's answer from the write: the tickets it really moved, and what
 * its (person, listing) pair still owes afterwards. */
export type TicketMoveAnswer = TicketMove & { owedAfter: number };

/** One stored booking line, as the write reads it. */
export type StoredTicketLine = Pick<
  ListingAttendeeRow,
  "checked_in" | "listing_id" | "quantity"
> & { attendee_id: number; id: number };

/** A line's new admitted count. */
export type ChangedTicketLine = { checked_in: number; id: number };

/** How many tickets one line can still move each way. */
const ROOM: Record<TicketDirection, (line: StoredTicketLine) => number> = {
  admit: remainingTickets,
  release: (line) => line.checked_in,
};

const STEP: Record<TicketDirection, number> = { admit: 1, release: -1 };

/** Move each count over the person's lines on that listing in the order
 * given, filling (or emptying) one line before the next. Answers the lines
 * that changed, the tickets each move really moved (less than asked when the
 * lines run out of room), and what each pair still owes afterwards. */
export const spreadTicketMoves = (
  direction: TicketDirection,
  lines: readonly StoredTicketLine[],
  moves: readonly TicketMove[],
): { changed: ChangedTicketLine[]; moved: TicketMoveAnswer[] } => {
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
  const linesByPair = Map.groupBy(
    after,
    (line: StoredTicketLine) => `${line.attendee_id}:${line.listing_id}`,
  );
  const owedIn = sumOf(
    (line: StoredTicketLine) => line.quantity - line.checked_in,
  );
  const movedWithOwed = moved.map((move) => ({
    ...move,
    owedAfter: owedIn(
      linesByPair.get(`${move.attendeeId}:${move.listingId}`) ?? [],
    ),
  }));
  return { changed, moved: movedWithOwed };
};
/** The tickets a set of moves covers in total. */
export const ticketCount: (moves: Iterable<TicketMove>) => number = sumOf(
  (move: TicketMove) => move.count,
);
