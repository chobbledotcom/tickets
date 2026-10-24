/** A door's ticket move and its activity record, written as one unit. Every
 * door surface (the ticket page, the scanner, the roster) moves tickets
 * through here, so a check-in never lands without its activity row. */

import {
  movesThatMoved,
  type TicketDirection,
  type TicketMove,
  type TicketMoveAnswer,
} from "#booking/ticket-moves.ts";
import { logActivities } from "#db/activity-log.ts";
import { moveTickets } from "#db/attendees/update.ts";
import { type TxScope, withTransaction } from "#db/client.ts";

/** The once-only hold one queued delivery takes on a write. `reserve`
 * claims the delivery's pair inside the write's transaction before any
 * move runs. It answers false when that pair is already stored: the
 * delivery is a retry of one that landed, so the write moves nothing.
 * `settle`, when the write really moved tickets, corrects the stored
 * admission to what the move really took. It runs in that same
 * transaction. */
export type ScanOperationGuard = {
  reserve: (tx: TxScope) => Promise<boolean>;
  settle?: (moved: readonly TicketMoveAnswer[], tx: TxScope) => Promise<void>;
};

/** Move the tickets and log one activity row per move that really moved
 * some, worded by `describe`. A move that moved nothing (another door took
 * the tickets first, or the lines were already in the asked state) writes
 * no row. Answers every move's result.
 *
 * `guard`, when the caller hands one over, reserves the caller's delivery
 * inside this same transaction before any move runs. It settles the
 * stored admission to the real move afterwards. A queued offline delivery
 * that lost its first answer replays with the id it made up. The replay
 * then reserves nothing and moves nothing, so one delivery never admits a
 * second ticket. */
export const moveTicketsAndLog = (
  direction: TicketDirection,
  moves: readonly TicketMove[],
  describe: (move: TicketMoveAnswer) => string,
  guard?: ScanOperationGuard,
): Promise<TicketMoveAnswer[]> =>
  withTransaction(async (tx) => {
    if (guard && !(await guard.reserve(tx))) return [];
    const moved = await moveTickets(direction, moves, tx);
    await logActivities(
      movesThatMoved(moved).map((move) => ({
        attendeeId: move.attendeeId,
        listing: move.listingId,
        message: describe(move),
      })),
      tx,
    );
    await guard?.settle?.(moved, tx);
    return moved;
  });

/** "1 ticket" or "3 tickets", as the activity log words a move. */
export const ticketsWord = (count: number): string =>
  `${count} ticket${count === 1 ? "" : "s"}`;
