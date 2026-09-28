/** How many of a booking line's tickets the doors have not admitted yet.
 * The one home for the "what does this line still owe" question the door
 * flows and the roster links both ask. */

import { sumOf } from "#fp";
import type { PairBooking } from "#types";

export const remainingTickets = (line: {
  checked_in: number;
  quantity: number;
}): number => line.quantity - line.checked_in;

/** A person's booking on one listing: the counts of every line no refund
 * returned, added up. These are the only lines the check-in write moves. */
export const movableBooking = (
  lines: readonly (PairBooking & { refunded: boolean })[],
): PairBooking => {
  const movable = lines.filter((line) => !line.refunded);
  return {
    checked_in: sumOf((line: PairBooking) => line.checked_in)(movable),
    quantity: sumOf((line: PairBooking) => line.quantity)(movable),
  };
};
