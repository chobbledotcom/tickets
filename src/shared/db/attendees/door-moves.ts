/** A door's ticket move and its activity record, written as one unit. Every
 * door surface (the ticket page, the scanner, the roster) moves tickets
 * through here, so a check-in never lands without its activity row. */

import type {
  TicketDirection,
  TicketMove,
  TicketMoveAnswer,
} from "#booking/ticket-moves.ts";
import { logActivities } from "#db/activity-log.ts";
import { moveTickets } from "#db/attendees/update.ts";
import { withTransaction } from "#db/client.ts";

/** Move the tickets and log one activity row per move that really moved
 * some, worded by `describe`. A move that moved nothing (another door took
 * the tickets first, or the lines were already in the asked state) writes
 * no row. Answers every move's result. */
export const moveTicketsAndLog = (
  direction: TicketDirection,
  moves: readonly TicketMove[],
  describe: (move: TicketMoveAnswer) => string,
): Promise<TicketMoveAnswer[]> =>
  withTransaction(async (tx) => {
    const moved = await moveTickets(direction, moves, tx);
    await logActivities(
      moved
        .filter((move) => move.count > 0)
        .map((move) => ({
          attendeeId: move.attendeeId,
          listing: move.listingId,
          message: describe(move),
        })),
      tx,
    );
    return moved;
  });

/** "1 ticket" or "3 tickets", as the activity log words a move. */
export const ticketsWord = (count: number): string =>
  `${count} ticket${count === 1 ? "" : "s"}`;
