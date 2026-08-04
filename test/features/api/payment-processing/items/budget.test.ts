/**
 * Revalidating a paid order must not spend one database call per line. A big
 * order would otherwise exhaust the edge request's subrequest budget and fail
 * the buyer after their money was taken.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { validateAllItems } from "#routes/api/payment-processing/items.ts";
import type { BookingIntent, BookingItem } from "#shared/booking-intent.ts";
import { invalidateListingsCache } from "#shared/db/listings/records.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";
import { bookingIntent, paymentSession } from "../index/helpers.ts";

/** Enough for the fixed reads, far below one read per order line. */
const ORDER_CALL_LIMIT = 8;

const orderIntent = async (
  label: string,
  lineCount: number,
): Promise<BookingIntent> => {
  const items: BookingItem[] = [];
  for (let index = 0; index < lineCount; index++) {
    const listing = await createTestListing({
      maxAttendees: 20,
      name: `${label} listing ${index}`,
      unitPrice: 500,
    });
    items.push({ e: listing.id, p: 500, q: 1 });
  }
  return bookingIntent(items);
};

/** Validate the order from a cold listing cache, under a hard call allowance. */
const coldValidationCalls = (intent: BookingIntent): Promise<number> => {
  invalidateListingsCache();
  return countDatabaseCalls(ORDER_CALL_LIMIT, () =>
    validateAllItems(
      paymentSession("cs_items_budget", 500 * intent.items.length, intent),
      intent,
    ),
  );
};

describeWithEnv("paid order validation budget", { db: true }, () => {
  test("costs the same reads for eight lines as for two", async () => {
    const two = await orderIntent("Small order", 2);
    const eight = await orderIntent("Large order", 8);

    expect(await coldValidationCalls(eight)).toBe(
      await coldValidationCalls(two),
    );
  });
});
