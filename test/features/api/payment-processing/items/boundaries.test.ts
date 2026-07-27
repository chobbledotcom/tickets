import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { validateAllItems } from "#routes/api/payment-processing/items.ts";
import { setGroupPackageMembers } from "#shared/db/groups.ts";
import type { BookingIntent } from "#shared/payments.ts";
import {
  bookingIntent,
  paymentSession,
} from "#test/features/api/payment-processing/index/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createHiddenPackageGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  pastCloseTime,
} from "#test-utils/db-helpers/listings.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stubRefundPayment } from "#test-utils/webhooks.ts";
import { nonStandalonePair, packageParentOrder } from "./helpers.ts";

const pricesFor = async (
  id: string,
  amount: number,
  intent: BookingIntent,
): Promise<Array<number | null>> => {
  const result = await validateAllItems(paymentSession(id, amount), intent);
  if (!("ok" in result) || !result.ok) {
    throw new Error(`Expected validated items, got ${JSON.stringify(result)}`);
  }
  return result.items.map((item) => item.expectedPrice);
};

describeWithEnv("paid item validation boundaries", { db: true }, () => {
  test("returns the generic closed result for a single listing", async () => {
    await setupStripe();
    const listing = await createTestListing({
      closesAt: pastCloseTime(),
      maxAttendees: 5,
      unitPrice: 400,
    });
    const intent = bookingIntent([{ e: listing.id, p: 400, q: 1 }]);
    using refund = stubRefundPayment("re_items_single_closed");

    expect(
      await validateAllItems(
        paymentSession("cs_items_single_closed", 400),
        intent,
      ),
    ).toEqual({
      detail: undefined,
      error: "Sorry, registration closed while you were completing payment.",
      refunded: true,
      status: 410,
      success: false,
    });
    expect(refund.calls).toHaveLength(1);
  });

  test("fails one standalone listing that joined a hidden package", async () => {
    const group = await createHiddenPackageGroup("Hidden after checkout");
    const member = await createTestListing({
      groupId: group.id,
      maxAttendees: 5,
      unitPrice: 500,
    });
    await setGroupPackageMembers(group.id, [
      { listingId: member.id, price: 500 },
    ]);
    const intent = bookingIntent([{ e: member.id, p: 500, q: 1 }]);

    expect(await pricesFor("cs_items_one_hidden", 500, intent)).toEqual([null]);
  });

  test("fails one child that can no longer be booked by itself", async () => {
    const { child } = await nonStandalonePair({}, { unitPrice: 200 });
    const intent = bookingIntent([{ e: child.id, p: 200, q: 1 }]);

    expect(await pricesFor("cs_items_one_child", 200, intent)).toEqual([null]);
  });

  test("checks an allocated child surplus even with no standalone line id", async () => {
    const { intent } = await packageParentOrder(2);

    expect(await pricesFor("cs_items_allocated_surplus", 1000, intent)).toEqual(
      [null, null],
    );
  });
});
