/** Assertions for the order this application asks Square to create: the line
 *  items in the order they were priced, and the intent fields the order
 *  metadata carries. */

import { expect } from "@std/expect";
import { readSessionOrder } from "#routes/api/payment-processing/metadata.ts";
import { extractSessionMetadata } from "#shared/payment-helpers.ts";
import type { CreatePaymentLinkInput } from "#shared/square/client.ts";
import { wireMetadata } from "#test-utils/payment-session.ts";

/** One line of the order as the checkout priced it. `amount` is the charged
 *  minor units per unit; leave it out where the test does not price the line. */
export type ExpectedOrderLine = {
  amount?: number;
  name: string;
  note: string;
  quantity: string;
};

/** The buyer's intent fields the order metadata must decode back to. */
export type ExpectedOrderMetadata = {
  email: string;
  items: unknown[];
  name: string;
  phone: string;
};

/** Assert the order carries exactly these line items, in this order. */
export const expectOrderLines = (
  order: CreatePaymentLinkInput["order"],
  lines: readonly ExpectedOrderLine[],
): void => {
  expect(order.lineItems).toHaveLength(lines.length);
  for (const [index, expected] of lines.entries()) {
    const line = order.lineItems[index]!;
    expect(line.name).toBe(expected.name);
    expect(line.quantity).toBe(expected.quantity);
    expect(line.note).toBe(expected.note);
    if (expected.amount !== undefined) {
      expect(line.basePriceMoney.amount).toBe(BigInt(expected.amount));
    }
  }
};

/** Assert the order metadata opens to the intent fields. The metadata holds
 *  only a token, so open the sealed order the way the webhook does. */
export const expectOrderMetadata = async (
  order: CreatePaymentLinkInput["order"],
  expected: ExpectedOrderMetadata,
): Promise<void> => {
  const metadata = extractSessionMetadata(wireMetadata(order.metadata));
  const opened = await readSessionOrder({ metadata });
  expect(opened.status).toBe("read");
  if (opened.status !== "read") return;
  expect({
    email: opened.intent.email,
    name: opened.intent.name,
    phone: opened.intent.phone,
  }).toEqual({
    email: expected.email,
    name: expected.name,
    phone: expected.phone,
  });
  expect(opened.intent.items).toEqual(expected.items);
};
