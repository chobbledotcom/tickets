/**
 * How a count of things is written in the short labels buyers and operators
 * read: "x3" in "Tickets (x3)" on a provider order, "x3 listings" in a group
 * flash message. One mechanism keeps every count reading the same way.
 */

import type { PricedLine } from "#shared/checkout-pricing.ts";

/** The count alone — "x3" — for a label that names the thing it counts. */
export const xCount = (count: number): string => `x${count}`;

/** A thing and its count, the way a provider order shows them: "Tickets (x3)". */
export const countedText = (thing: string, count: number): string =>
  `${thing} (${xCount(count)})`;

/** What an order is called: the one listing every line sits on, so the buyer
 * reads the event they booked; "Tickets" when the order mixes listings (or
 * holds none), so the name never picks one listing out of several. */
export const orderLabel = (lines: readonly PricedLine[]): string => {
  const firstName = lines[0]?.item.name;
  return firstName !== undefined &&
    lines.every((line) => line.item.name === firstName)
    ? firstName
    : "Tickets";
};
