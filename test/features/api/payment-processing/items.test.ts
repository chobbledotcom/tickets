import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { setGroupPackageMembers } from "#db/groups.ts";
import { updateListing } from "#db/listings/records.ts";
import { withMessageGroups } from "#i18n";
import { validateAllItems as validateSnapshotItems } from "#routes/api/payment-processing/items.ts";
import type { ValidatedItem } from "#routes/api/payment-processing/package-pricing.ts";
import { loadPaidOrderSnapshot } from "#routes/api/payment-processing/snapshot/io.ts";
import type { PaymentResult } from "#routes/api/webhook-types.ts";
import { validateAllItems } from "#test/features/api/payment-processing/items/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createHiddenPackageGroup,
  createTestGroup,
} from "#test-utils/db-helpers/groups.ts";
import { createListingWithStoredQuantities } from "#test-utils/db-helpers/listing-quantities.ts";
import {
  createDeactivatedTestListing,
  createTestListing,
  deactivateTestListing,
  pastCloseTime,
} from "#test-utils/db-helpers/listings.ts";
import { validateListingBooking } from "#test-utils/paid-item-validation.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stripeRefundRequestShape } from "#test-utils/stripe/fixtures.ts";
import {
  type StripeRefundStub,
  stubRefundPayment,
} from "#test-utils/webhooks/stripe.ts";
import { bookingIntent, paymentSession } from "./index/helpers.ts";
import {
  listingPair,
  nonStandalonePair,
  packageParentOrder,
} from "./items/helpers.ts";

type ValidationResult = Awaited<ReturnType<typeof validateAllItems>>;

const validatedItems = (result: ValidationResult): ValidatedItem[] => {
  if (!("ok" in result) || !result.ok) {
    throw new Error(`Expected validated items, got ${JSON.stringify(result)}`);
  }
  return result.items;
};

const failureResult = (
  result: ValidationResult,
): PaymentResult & { success: false } => {
  if (!("success" in result) || result.success) {
    throw new Error(
      `Expected validation failure, got ${JSON.stringify(result)}`,
    );
  }
  return result;
};

/** Assert that the webhook refused the payment, named the reason, and refunded
 *  the captured amount. */
const expectRefunded = (
  result: ValidationResult,
  refund: StripeRefundStub,
  expected: { error: string; paymentIntentId: string; total: number },
): void => {
  expect(failureResult(result)).toEqual({
    detail: undefined,
    error: expected.error,
    refunded: true,
    status: 410,
    success: false,
  });
  expect(refund.calls[0]?.args).toEqual([
    stripeRefundRequestShape(expected.paymentIntentId, expected.total),
  ]);
};

/** A buyer's checkout against a listing whose stored bound moved after the
 *  checkout opened. The webhook re-reads the stored fact and refunds instead of
 *  booking a quantity the listing now refuses. */
const movedBoundCases = [
  {
    // The buyer opened the checkout at one ticket; the owner then raised the
    // stored minimum to three. The webhook is the last minimum check.
    error: "Sorry, Raised floor sells at least 3 tickets per booking.",
    listingName: "Raised floor",
    quantity: 1,
    refundId: "re_items_minimum",
    sessionId: "cs_items_minimum",
    stored: { minQuantity: 3 },
    testName:
      "refunds a paid checkout whose listing minimum rose above its quantity",
    total: 500,
  },
  {
    // The buyer opened the checkout at two tickets; the owner then lowered the
    // stored maximum to one.
    error: "Sorry, Lowered ceiling sells at most 1 ticket per booking.",
    listingName: "Lowered ceiling",
    quantity: 2,
    refundId: "re_items_maximum",
    sessionId: "cs_items_maximum",
    stored: { maxQuantity: 1 },
    testName:
      "refunds a paid checkout whose listing maximum dropped below its quantity",
    total: 500,
  },
];

describeWithEnv("paid item validation", { db: true }, () => {
  test("uses the one-day price when the session has no chosen day count", async () => {
    const listing = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 400, 2: 700 },
      durationDays: 2,
      listingType: "daily",
      maxAttendees: 5,
      maximumDaysAfter: 30,
      minimumDaysBefore: 0,
      unitPrice: 400,
    });
    const intent = bookingIntent([{ e: listing.id, p: 400, q: 1 }]);

    const items = validatedItems(
      await validateAllItems(
        paymentSession("cs_items_days", 400, intent),
        intent,
      ),
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.expectedPrice).toBe(400);
    expect(items[0]?.listing.id).toBe(listing.id);
  });

  test("returns a non-refundable not-found result for an unknown listing", async () => {
    const intent = bookingIntent([{ e: 999_999, p: 500, q: 1 }]);

    expect(
      failureResult(
        await validateAllItems(
          paymentSession("cs_items_missing", 500, intent),
          intent,
        ),
      ),
    ).toEqual({
      detail: "Post-payment listing not found (session=cs_items_missing)",
      error: "Listing not found",
      status: 404,
      success: false,
    });
  });

  test("names an inactive standalone listing", async () => {
    await setupStripe();
    const listing = await createDeactivatedTestListing({
      maxAttendees: 5,
      name: "Private workshop",
      unitPrice: 500,
    });

    const { refund, result } = await validateListingBooking(
      "cs_items_inactive",
      listing.id,
      500,
      "re_items_inactive",
    );

    expectRefunded(result, refund, {
      error: "Private workshop is no longer accepting registrations.",
      paymentIntentId: "pi_cs_items_inactive",
      total: 500,
    });
  });

  for (const boundCase of movedBoundCases) {
    test(boundCase.testName, async () => {
      await setupStripe();
      const listing = await createListingWithStoredQuantities(
        { maxAttendees: 5, name: boundCase.listingName, unitPrice: 500 },
        boundCase.stored,
      );
      const intent = bookingIntent([
        { e: listing.id, p: 500, q: boundCase.quantity },
      ]);
      using refund = stubRefundPayment(boundCase.refundId, boundCase.total);

      const result = await withMessageGroups(["payment"], () =>
        validateAllItems(
          paymentSession(boundCase.sessionId, boundCase.total, intent),
          intent,
        ),
      );
      expectRefunded(result, refund, {
        error: boundCase.error,
        paymentIntentId: `pi_${boundCase.sessionId}`,
        total: boundCase.total,
      });
    });
  }

  test("refunds a hidden package member whose maximum dropped, without naming it", async () => {
    // A concealed member's name must not reach the buyer, so the refusal
    // uses the unnamed copy even though the order carries the member.
    await setupStripe();
    const { intent } = await packageParentOrder(1);
    const [, child] = intent.items;
    // The folded child line carries two units, and the owner has since
    // lowered the member's stored maximum to one.
    const allocation = intent.allocations?.[0];
    if (allocation) allocation.qty = 2;
    child!.q = 2;
    child!.p = 400;
    const { listingsTable } = await import("#db/listings/records.ts");
    await updateListing(child!.e, { maxQuantity: 1 });
    const snapshot = await loadPaidOrderSnapshot(
      "cs_items_hidden_maximum",
      intent,
    );
    snapshot.notificationPackages.displays = new Map();
    const amount = intent.items.reduce((total, item) => total + item.p, 0);
    using refund = stubRefundPayment("re_items_hidden_maximum", amount);

    const result = await withMessageGroups(["payment"], () =>
      validateSnapshotItems(
        paymentSession("cs_items_hidden_maximum", amount, intent),
        intent,
        snapshot,
      ),
    );
    expectRefunded(result, refund, {
      error: "Sorry, this listing sells at most 1 ticket per booking.",
      paymentIntentId: "pi_cs_items_hidden_maximum",
      total: amount,
    });
  });

  test("names the listing that closed in a visible multi-listing order", async () => {
    await setupStripe();
    const open = await createTestListing({ maxAttendees: 5, unitPrice: 300 });
    const closed = await createTestListing({
      closesAt: pastCloseTime(),
      maxAttendees: 5,
      name: "Evening class",
      unitPrice: 400,
    });
    const intent = bookingIntent([
      { e: open.id, p: 300, q: 1 },
      { e: closed.id, p: 400, q: 1 },
    ]);
    using refund = stubRefundPayment("re_items_closed", 700);

    expect(
      failureResult(
        await validateAllItems(
          paymentSession("cs_items_closed", 700, intent),
          intent,
        ),
      ).error,
    ).toBe(
      "Sorry, registration for Evening class closed while you were completing payment.",
    );
    expect(refund.calls).toHaveLength(1);
  });

  test("names the package for an inactive concealed member", async () => {
    await setupStripe();
    const group = await createHiddenPackageGroup("Hidden pair");
    const first = await createTestListing({
      groupId: group.id,
      unitPrice: 300,
    });
    const second = await createTestListing({
      groupId: group.id,
      name: "Secret member",
      unitPrice: 400,
    });
    await setGroupPackageMembers(group.id, [
      { listingId: first.id, price: 300 },
      { listingId: second.id, price: 400 },
    ]);
    await deactivateTestListing(second.id);
    const intent = bookingIntent([
      { e: first.id, k: "p", p: 300, q: 1, r: group.id },
      { e: second.id, k: "p", p: 400, q: 1, r: group.id },
    ]);
    using refund = stubRefundPayment("re_hidden_package", 700);

    expect(
      failureResult(
        await validateAllItems(
          paymentSession("cs_items_hidden", 700, intent),
          intent,
        ),
      ).error,
    ).toBe("Hidden pair is no longer accepting registrations.");
    expect(refund.calls).toHaveLength(1);
  });

  test("keeps a standalone line after its listing joins a concealing package", async () => {
    await setupStripe();
    const group = await createHiddenPackageGroup("New hidden package");
    const member = await createTestListing({
      groupId: group.id,
      maxAttendees: 5,
      name: "Now secret",
      unitPrice: 500,
    });
    await setGroupPackageMembers(group.id, [
      { listingId: member.id, price: 500 },
    ]);
    const other = await createTestListing({ maxAttendees: 5, unitPrice: 200 });
    const intent = bookingIntent([
      { e: member.id, p: 500, q: 1 },
      { e: other.id, p: 200, q: 1 },
    ]);

    expect(
      validatedItems(
        await validateAllItems(
          paymentSession("cs_items_stale_hidden", 700, intent),
          intent,
        ),
      ).map((item) => item.expectedPrice),
    ).toEqual([500, 200]);

    await deactivateTestListing(member.id);
    using refund = stubRefundPayment("re_stale_hidden", 700);
    expect(
      failureResult(
        await validateAllItems(
          paymentSession("cs_items_stale_hidden_closed", 700, intent),
          intent,
        ),
      ).error,
    ).toBe("Now secret is no longer accepting registrations.");
    expect(refund.calls).toHaveLength(1);
  });

  test("accepts a fully folded child whose standalone flag was cleared", async () => {
    const { intent } = await packageParentOrder(1);

    expect(
      validatedItems(
        await validateAllItems(
          paymentSession("cs_items_folded", 800, intent),
          intent,
        ),
      ).map((item) => item.expectedPrice),
    ).toEqual([600, 200]);
  });

  test("fails a mixed folded and standalone child after its flag is cleared", async () => {
    const { child, parent } = await nonStandalonePair(
      { unitPrice: 600 },
      { maxQuantity: 2, unitPrice: 200 },
    );
    // One folded allocation plus a two-unit standalone line, inside the
    // child's per-order maximum: the refusal must come from the mixed flag,
    // not from a quantity a line cannot carry.
    const intent = bookingIntent(
      [
        { e: parent.id, p: 600, q: 1 },
        { e: child.id, p: 400, q: 2 },
      ],
      { allocations: [{ childId: child.id, parentId: parent.id, qty: 1 }] },
    );

    expect(
      validatedItems(
        await validateAllItems(
          paymentSession("cs_items_child_surplus", 1000, intent),
          intent,
        ),
      ).map((item) => item.expectedPrice),
    ).toEqual([null, null]);
  });

  test("does not treat a package-only child as a stale standalone booking", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "Child bundle",
    });
    const { child } = await listingPair(
      {},
      {
        groupId: group.id,
        unitPrice: 250,
      },
    );
    await setGroupPackageMembers(group.id, [
      { listingId: child.id, price: 150 },
    ]);
    const intent = bookingIntent([
      { e: child.id, k: "p", p: 150, q: 1, r: group.id },
    ]);

    expect(
      validatedItems(
        await validateAllItems(
          paymentSession("cs_items_package_child", 150, intent),
          intent,
        ),
      )[0]?.expectedPrice,
    ).toBe(150);
  });

  test("fails a bundle whose current membership gained a line", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "Growing bundle",
    });
    const original = await createTestListing({
      groupId: group.id,
      unitPrice: 300,
    });
    const added = await createTestListing({
      groupId: group.id,
      unitPrice: 200,
    });
    await setGroupPackageMembers(group.id, [
      { listingId: original.id, price: 300 },
      { listingId: added.id, price: 200 },
    ]);
    const intent = bookingIntent([
      { e: original.id, k: "p", p: 300, q: 1, r: group.id },
    ]);

    expect(
      validatedItems(
        await validateAllItems(
          paymentSession("cs_items_bundle_drift", 300, intent),
          intent,
        ),
      )[0]?.expectedPrice,
    ).toBeNull();
  });

  test("fails a parent that gained a required child during payment", async () => {
    const { parent } = await listingPair(
      { unitPrice: 500 },
      { unitPrice: 100 },
    );
    const intent = bookingIntent([{ e: parent.id, p: 500, q: 1 }]);

    expect(
      validatedItems(
        await validateAllItems(
          paymentSession("cs_items_edge_drift", 500, intent),
          intent,
        ),
      )[0]?.expectedPrice,
    ).toBeNull();
  });

  test("leaves a folded child nameless when its parent line is absent", async () => {
    const group = await createHiddenPackageGroup("Concealed bundle");
    // The child's empty name only has meaning while this package holds group
    // id 1, the id next to the standalone key 0 a wrong lookup would reach.
    expect(group.id).toBe(1);
    const member = await createTestListing({
      groupId: group.id,
      unitPrice: 300,
    });
    await setGroupPackageMembers(group.id, [
      { listingId: member.id, price: 300 },
    ]);
    const { child, parent } = await listingPair({}, {});
    const intent = bookingIntent(
      [
        { e: member.id, k: "p", p: 300, q: 1, r: group.id },
        { e: child.id, p: 200, q: 1 },
      ],
      { allocations: [{ childId: child.id, parentId: parent.id, qty: 1 }] },
    );

    expect(
      validatedItems(
        await validateAllItems(
          paymentSession("cs_items_nameless_child", 500, intent),
          intent,
        ),
      ).map((item) => item.name),
    ).toEqual(["Concealed bundle", ""]);
  });
});
