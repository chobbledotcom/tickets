/**
 * Split each order's modifier lines across the ticket cards that show its
 * bookings. A modifier leg belongs to the whole order, and a card is one
 * booking. The card shows the ticket share of the order's modifier, in the
 * same proportion the ledger splits the sale: by ticket count.
 */

import { groupToMap } from "#fp";
import type { TokenEntry } from "#routes/tickets/token-utils.ts";
import { largestRemainderAllocation } from "#shared/largest-remainder.ts";

/** One modifier's name and its signed change to a price. */
export type ModifierLine = { amount: number; name: string };

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
  const weights = entries.map((entry) => entry.attendee.quantity);
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
