/** The declared review machine: for each node, the events that must move
 * it and where to. Every other (event × shape) pair must refuse. A held
 * case blocks a second open, only its own evidence retires it, and only
 * an unseen case can be acknowledged.
 *
 * The table declares what the mirror test holds the real review
 * functions to. The contract drift dump reads it so a change to a
 * declared refusal shows in a branch's semantic report. */

import type {
  ReviewEventId,
  ReviewNodeId,
} from "#payment/review-machine-spec.ts";
import type { MachineMoves } from "#shared/schema-atlas/machine-spec.ts";

/** A held case retires the same way whether or not it was seen: only its
 * own reason's evidence sends it back to the empty slot. */
const RETIRE_MOVES = {
  retire_partially_returned_obligation: {
    perRep: { partially_returned_obligation: "none" },
  },
  retire_shared_reference: { perRep: { shared_reference: "none" } },
} as const;

export const EXPECTED_MOVES: MachineMoves<ReviewNodeId, ReviewEventId> = {
  none: {
    open_partially_returned_obligation: "open",
    open_shared_reference: "open",
  },
  open: { acknowledge: "seen", ...RETIRE_MOVES },
  seen: RETIRE_MOVES,
};
