import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { validateAllItems } from "#routes/api/payment-processing/items.ts";
import type { ValidatedItem } from "#routes/api/payment-processing/package-pricing.ts";
import type { PaymentResult } from "#routes/api/webhook-types.ts";
import { setGroupPackageMembers } from "#shared/db/groups.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createHiddenPackageGroup,
  createTestGroup,
} from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  deactivateTestListing,
  pastCloseTime,
} from "#test-utils/db-helpers/listings.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {} from "#test-utils/webhooks.ts";
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
      await validateAllItems(paymentSession("cs_items_days", 400), intent),
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.expectedPrice).toBe(400);
    expect(items[0]?.listing.id).toBe(listing.id);
  });

  test("returns a non-refundable not-found result for an unknown listing", async () => {
    const intent = bookingIntent([{ e: 999_999, p: 500, q: 1 }]);

    expect(
      failureResult(
        await validateAllItems(paymentSession("cs_items_missing", 500), intent),
      ),
    ).toEqual({
      detail:
        "Post-payment listing validation failed (session=cs_items_missing)",
      error: "Listing not found",
      status: 404,
      success: false,
    });
  });

  test("reports an inactive single listing without exposing its name", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 5,
      name: "Private workshop",
      unitPrice: 500,
    });
    await deactivateTestListing(listing.id);
    const intent = bookingIntent([{ e: listing.id, p: 500, q: 1 }]);

    expect(
      failureResult(
        await validateAllItems(
          paymentSession("cs_items_inactive", 500),
          intent,
        ),
      ),
    ).toEqual({
      detail:
        "Post-payment listing validation failed (session=cs_items_inactive)",
      error: "This listing is no longer accepting registrations.",
      status: 410,
      success: false,
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

    expect(
      failureResult(
        await validateAllItems(paymentSession("cs_items_closed", 700), intent),
      ).error,
    ).toBe(
      "Sorry, registration for Evening class closed while you were completing payment.",
    );
  });

  test("conceals an inactive member name in a hidden package", async () => {
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

    expect(
      failureResult(
        await validateAllItems(paymentSession("cs_items_hidden", 700), intent),
      ).error,
    ).toBe("This listing is no longer accepting registrations.");
  });

  test("conceals a stale standalone member and fails the order closed", async () => {
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
          paymentSession("cs_items_stale_hidden", 700),
          intent,
        ),
      ).map((item) => item.expectedPrice),
    ).toEqual([null, null]);

    await deactivateTestListing(member.id);
    expect(
      failureResult(
        await validateAllItems(
          paymentSession("cs_items_stale_hidden_closed", 700),
          intent,
        ),
      ).error,
    ).toBe("This listing is no longer accepting registrations.");
  });

  test("accepts a fully folded child whose standalone flag was cleared", async () => {
    const { intent } = await packageParentOrder(1);

    expect(
      validatedItems(
        await validateAllItems(paymentSession("cs_items_folded", 800), intent),
      ).map((item) => item.expectedPrice),
    ).toEqual([600, 200]);
  });

  test("fails a mixed folded and standalone child after its flag is cleared", async () => {
    const { child, parent } = await nonStandalonePair(
      { unitPrice: 600 },
      { unitPrice: 200 },
    );
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
          paymentSession("cs_items_child_surplus", 1000),
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
          paymentSession("cs_items_package_child", 150),
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
          paymentSession("cs_items_bundle_drift", 300),
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
          paymentSession("cs_items_edge_drift", 500),
          intent,
        ),
      )[0]?.expectedPrice,
    ).toBeNull();
  });
});
