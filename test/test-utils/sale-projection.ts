/** The money a checkout with a modifier leaves behind, asserted in one place. */

import { expect } from "@std/expect";
import {
  modifierUsageAmount,
  modifierUsageCount,
} from "#test-utils/modifiers.ts";

/** What the attendee's money state and the modifier's usage must read. */
export type SaleProjection = {
  /** The gross sale leg the ledger projects, never the discounted total. */
  pricePaid: number;
  /** The balance the attendee still owes after the payment taken. */
  remainingBalance: number;
  /** Total `amount_applied` the modifier recorded. */
  usageAmount: number;
  /** Total quantity the modifier recorded. */
  usageCount: number;
};

/** The attendee's projected money, from the booking the checkout returned. */
export type SaleSubject = {
  readonly pricePaid: number;
  readonly remainingBalance: number;
};

/** Assert the attendee's projected money and the usage its modifier recorded. */
export const expectSaleProjection = async (
  attendee: SaleSubject,
  modifierId: number,
  expected: SaleProjection,
): Promise<void> => {
  expect({
    pricePaid: attendee.pricePaid,
    remainingBalance: attendee.remainingBalance,
    usageAmount: await modifierUsageAmount(modifierId),
    usageCount: await modifierUsageCount(modifierId),
  }).toEqual(expected);
};
