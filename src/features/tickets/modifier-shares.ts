/**
 * Split each order's modifier lines across the ticket cards that show its
 * bookings. A modifier leg belongs to the whole order, and a card is one
 * booking. A modifier follows the price of the tickets. A percentage charge
 * scales with their price, and a discount comes off each ticket in proportion
 * to its price. So a card's share follows its share of the order's ticket
 * income, the figure the card shows as its price.
 */

import { groupToMap, sum } from "#fp";
import type { TokenEntry } from "#routes/tickets/token-utils.ts";
import { largestRemainderAllocation } from "#shared/largest-remainder.ts";

/** One modifier's name and its signed change to a price. */
export type ModifierLine = { amount: number; name: string };

/** What decides each card's share of its order. That is the ticket income the
 *  card shows as its price. An order that earned nothing (a free booking with
 *  a charge) has no price to follow, so the count of tickets decides. */
const weightsFor = (entries: readonly TokenEntry[]): number[] => {
  const income = entries.map((entry) => Number(entry.attendee.price_paid));
  return sum(income) > 0
    ? income
    : entries.map((entry) => entry.attendee.quantity);
};

/** Split one order's modifiers across its cards. Largest remainder keeps every
 *  share a whole number of pennies, and the shares add up to the order's own
 *  figure. A share of zero changes no price, so the card omits it. */
const splitOrder = (
  entries: readonly TokenEntry[],
  modifiers: readonly ModifierLine[],
): Map<TokenEntry, ModifierLine[]> => {
  const shares = new Map<TokenEntry, ModifierLine[]>(
    entries.map((entry) => [entry, []]),
  );
  const weights = weightsFor(entries);
  for (const modifier of modifiers) {
    const parts = largestRemainderAllocation(
      weights,
      Math.abs(modifier.amount),
    );
    const sign = Math.sign(modifier.amount);
    for (const [index, entry] of entries.entries()) {
      const amount = sign * parts[index]!;
      if (amount !== 0) {
        shares.get(entry)!.push({ amount, name: modifier.name });
      }
    }
  }
  return shares;
};

/** The modifier lines each booking card shows. An order with no modifier legs
 *  has no entry in `modifiersByOrder`, so its cards show none. */
export const splitModifiersAcrossCards = (
  entries: readonly TokenEntry[],
  modifiersByOrder: ReadonlyMap<string, readonly ModifierLine[]>,
): Map<TokenEntry, ModifierLine[]> => {
  const byOrder = groupToMap(
    (entry: TokenEntry) => entry.ledgerEventGroup,
    (entry: TokenEntry) => entry,
  )(entries);
  return new Map(
    [...byOrder].flatMap(([order, orderEntries]) => [
      ...splitOrder(orderEntries, modifiersByOrder.get(order) ?? []),
    ]),
  );
};
