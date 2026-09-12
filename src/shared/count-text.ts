/**
 * How a count of things is written in the short labels buyers and operators
 * read: "x3" in "Tickets (x3)" on a provider order, "x3 listings" in a group
 * flash message. One mechanism keeps every count reading the same way.
 */

/** The count alone — "x3" — for a label that names the thing it counts. */
export const xCount = (count: number): string => `x${count}`;

/** The ticket count every payment provider's order shows: "Tickets (x3)". */
export const ticketsCountText = (count: number): string =>
  `Tickets (${xCount(count)})`;
