/**
 * The webhook's per-listing maximum rule at payment: the order's summed
 * quantity per listing is what the maximum judges, and a folded daily
 * child's line escapes the date-less cap its fold already handled.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { setGroupPackageMembers } from "#db/groups.ts";
import { withMessageGroups } from "#i18n";
import type { PaymentResult } from "#routes/api/webhook-types.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import {
  bookingIntent,
  paymentSession,
} from "#test/features/api/payment-processing/index/helpers.ts";
import { validateAllItems } from "#test/features/api/payment-processing/items/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stripeRefundRequestShape } from "#test-utils/stripe/fixtures.ts";
import { stubRefundPayment } from "#test-utils/webhooks/stripe.ts";
import { nonStandalonePair } from "./helpers.ts";

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
    const group = await createTestGroup({
      isPackage: true,
      name: "Daily bundle",
    });
    const { child, parent } = await nonStandalonePair(
      { groupId: group.id, unitPrice: 600 },
      { listingType: "daily", maxQuantity: 1, unitPrice: 200 },
    );
    await setGroupPackageMembers(group.id, [
      { listingId: parent.id, price: 600 },
    ]);
    const intent = bookingIntent(
      [
        { e: parent.id, k: "p", p: 600, q: 1, r: group.id },
        { e: child.id, p: 200 * 5, q: 5 },
      ],
      { allocations: [{ childId: child.id, parentId: parent.id, qty: 5 }] },
    );

    const result = await withMessageGroups(["payment"], () =>
      validateAllItems(
        paymentSession("cs_items_daily_fold", 1600, intent),
        intent,
      ),
    );
    expect(validatedQuantities(result)).toEqual([1, 5]);
  });
});
