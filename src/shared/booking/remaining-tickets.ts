/** How many of a booking line's tickets the doors have not admitted yet.
 * The one home for the "what does this line still owe" question the door
 * flows and the roster links both ask. */

export const remainingTickets = (line: {
  checked_in: number;
  quantity: number;
}): number => line.quantity - line.checked_in;
