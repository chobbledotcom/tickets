/**
 * The webhook's per-listing maximum rule at payment: the order's summed
 * quantity per listing is what the maximum judges, and a folded daily
 * child's line escapes the date-less cap its fold already handled.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { listingsTable } from "#db/listings/records.ts";
import { withMessageGroups } from "#i18n";
import type { PaymentResult } from "#routes/api/webhook-types.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import {
  bookingIntent,
  paymentSession,
} from "#test/features/api/payment-processing/index/helpers.ts";
import {
  bundlePairIntent,
  validateAllItems,
} from "#test/features/api/payment-processing/items/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stripeRefundRequestShape } from "#test-utils/stripe/fixtures.ts";
import { stubRefundPayment } from "#test-utils/webhooks/stripe.ts";
import { listingPair } from "./helpers.ts";

type ValidationResult = Awaited<ReturnType<typeof validateAllItems>>;

type FailureResult = PaymentResult & { success: false };

const validatedQuantities = (result: ValidationResult): number[] => {
  if (!("ok" in result) || !result.ok) {
    throw new Error(`Expected validated items, got ${JSON.stringify(result)}`);
  }
  return result.items.map((item) => item.item.q);
};

const failureResult = (result: ValidationResult): FailureResult => {
  if (!("success" in result) || result.success) {
    throw new Error(
      `Expected validation failure, got ${JSON.stringify(result)}`,
    );
  }
  return result;
};

/** A listing whose stored maximum the owner has since lowered, with a
 *  two-line order over it: the two paths the maximum's sum rule judges. */
const twoPathIntent = async (
  maxQuantity: number,
  first: number,
  second: number,
): Promise<BookingIntent> => {
  const listing = await createTestListing({
    maxAttendees: 5,
    name: "Two paths",
    unitPrice: 200,
  });
  const { execute } = await import("#db/client.ts");
  await execute("UPDATE listings SET max_quantity = ? WHERE id = ?", [
    maxQuantity,
    listing.id,
  ]);
  return bookingIntent([
    { e: listing.id, p: 200, q: first },
    { e: listing.id, p: 200, q: second },
  ]);
};

/** A daily bundle whose child rides five folded units, with the child's whole
 *  line carrying `childQuantity` units — the folded share plus any standalone
 *  surplus the caller asks for. `bookableAlone` decides whether the child's
 *  own row may carry that surplus. */
const dailyFoldIntent = async (
  bookableAlone: boolean,
  childQuantity: number,
): Promise<BookingIntent> => {
  const group = await createTestGroup({
    isPackage: true,
    name: "Daily bundle",
  });
  const { child, parent } = await listingPair(
    { groupId: group.id, unitPrice: 600 },
    {
      listingType: "daily",
      maxQuantity: 1,
      name: "Side Sale",
      unitPrice: 200,
    },
  );
  if (!bookableAlone) {
    await listingsTable.update(child.id, { bookableAlone: false });
  }
  return bundlePairIntent(group, { child, parent }, childQuantity, 5);
};

describeWithEnv("paid item validation — maximums", { db: true }, () => {
  test("refunds when two paths book one listing past its maximum together", async () => {
    // Each line sits under the per-order maximum, but the order books their
    // sum, so the webhook judges the sum.
    await setupStripe();
    const intent = await twoPathIntent(3, 2, 2);
    using refund = stubRefundPayment("re_items_two_paths", 800);

    const result = await withMessageGroups(["payment"], () =>
      validateAllItems(
        paymentSession("cs_items_two_paths", 800, intent),
        intent,
      ),
    );
    expect(failureResult(result)).toEqual({
      detail: undefined,
      error: "Sorry, Two paths sells at most 3 tickets per booking.",
      refunded: true,
      status: 410,
      success: false,
    });
    expect(refund.calls[0]?.args).toEqual([
      stripeRefundRequestShape("pi_cs_items_two_paths", 800),
    ]);
  });

  test("books two paths whose quantities stay within the maximum together", async () => {
    await setupStripe();
    const intent = await twoPathIntent(3, 2, 1);

    const result = await withMessageGroups(["payment"], () =>
      validateAllItems(
        paymentSession("cs_items_two_paths_ok", 600, intent),
        intent,
      ),
    );
    expect(validatedQuantities(result)).toEqual([2, 1]);
  });

  test("completes a folded daily child whose line exceeds the date-less maximum", async () => {
    // foldChild skips the date-less max-purchasable cap for daily children —
    // their per-date availability is the authority. The webhook re-reads the
    // stored facts, so it must not refund a booking the fold allowed.
    await setupStripe();
    const intent = await dailyFoldIntent(false, 5);

    const result = await withMessageGroups(["payment"], () =>
      validateAllItems(
        paymentSession("cs_items_daily_fold", 1600, intent),
        intent,
      ),
    );
    expect(validatedQuantities(result)).toEqual([1, 5]);
  });

  test("judges a folded daily child's standalone surplus against the maximum", async () => {
    // A bookable-alone daily child bought through its own row AND the bundle
    // folds into one line whose allocations hold only the folded share. The
    // fold owns that share's per-date availability; the standalone surplus is
    // a plain purchase, so the stored maximum still judges it.
    await setupStripe();
    const intent = await dailyFoldIntent(true, 7);
    using refund = stubRefundPayment("re_items_daily_surplus", 2000);

    const result = await withMessageGroups(["payment"], () =>
      validateAllItems(
        paymentSession("cs_items_daily_surplus", 2000, intent),
        intent,
      ),
    );
    expect(failureResult(result)).toEqual({
      detail: undefined,
      error: "Sorry, Side Sale sells at most 1 ticket per booking.",
      refunded: true,
      status: 410,
      success: false,
    });
    expect(refund.calls[0]?.args).toEqual([
      stripeRefundRequestShape("pi_cs_items_daily_surplus", 2000),
    ]);
  });
});
