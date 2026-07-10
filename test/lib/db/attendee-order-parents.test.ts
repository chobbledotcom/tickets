import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type {
  ChildAllocation,
  ListingBooking,
} from "#shared/db/attendee-types.ts";
import {
  annotateOrderParents,
  expandChildAllocations,
} from "#shared/db/attendees/order-parents.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** A bare booking line for a listing id (other fields default at insert time). */
const line = (listingId: number): ListingBooking => ({ listingId });

describeWithEnv("db > attendees > annotateOrderParents", { db: true }, () => {
  test("leaves a parent-less order untouched — no token, no parent", async () => {
    const a = await createTestListing({ name: "Solo A" });
    const b = await createTestListing({ name: "Solo B" });
    const result = await annotateOrderParents([line(a.id), line(b.id)]);
    // No booked child has an in-order parent, so the rows are returned as-is
    // (token stays "" and parent stays 0 at insert).
    expect(result).toEqual([line(a.id), line(b.id)]);
  });

  test("shares one token and records each child's parent", async () => {
    const parent = await createTestListing({ name: "Base" });
    const child = await createTestListing({ name: "Add-on" });
    await listingChildren.setIds(parent.id, [child.id]);

    const result = await annotateOrderParents([
      line(parent.id),
      line(child.id),
    ]);
    const parentRow = result.find((b) => b.listingId === parent.id)!;
    const childRow = result.find((b) => b.listingId === child.id)!;

    expect(parentRow.orderToken).toBeTruthy();
    expect(childRow.orderToken).toBe(parentRow.orderToken);
    expect(parentRow.parentListingId ?? 0).toBe(0);
    expect(childRow.parentListingId).toBe(parent.id);
  });

  test("ignores a child whose parent is not booked in this order", async () => {
    // The child has a parent edge, but the parent listing is not in the order —
    // so there is no in-order pairing to record and the order stays plain.
    const parent = await createTestListing({ name: "Absent base" });
    const child = await createTestListing({ name: "Lonely add-on" });
    await listingChildren.setIds(parent.id, [child.id]);

    const result = await annotateOrderParents([line(child.id)]);
    expect(result).toEqual([line(child.id)]);
  });

  test("records the first in-order parent for a child shared by two parents", async () => {
    // The rare multi-parent corner: the summed child row holds one parent, the
    // first whose listing is booked in the order.
    const parentA = await createTestListing({ name: "Base A" });
    const parentB = await createTestListing({ name: "Base B" });
    const child = await createTestListing({ name: "Shared add-on" });
    await listingChildren.setIds(parentA.id, [child.id]);
    await listingChildren.setIds(parentB.id, [child.id]);

    const result = await annotateOrderParents([
      line(parentA.id),
      line(parentB.id),
      line(child.id),
    ]);
    const childRow = result.find((b) => b.listingId === child.id)!;
    expect([parentA.id, parentB.id]).toContain(childRow.parentListingId);
  });

  test("skips recomputation when bookings already carry an orderToken", async () => {
    // Pre-expanded bookings (expandChildAllocations path) already have a token
    // set: annotateOrderParents must return them unchanged so the exact
    // parentListingId values are preserved.
    const token = "pre-set-token";
    const bookings: ListingBooking[] = [
      { listingId: 1, orderToken: token, parentListingId: 99 },
      { listingId: 2, orderToken: token },
    ];
    const result = await annotateOrderParents(bookings);
    // Returned as-is (same object references), no mutation.
    expect(result).toBe(bookings);
    expect(result[0]!.orderToken).toBe(token);
    expect(result[0]!.parentListingId).toBe(99);
  });
});

describe("db > attendees > expandChildAllocations", () => {
  /** A bare booking line. */
  const booking = (
    listingId: number,
    qty = 1,
    pricePaid?: number,
  ): ListingBooking => ({
    listingId,
    ...(pricePaid !== undefined ? { pricePaid } : {}),
    quantity: qty,
  });

  /** A per-(child, parent) allocation entry. */
  const alloc = (
    childId: number,
    parentId: number,
    qty: number,
  ): ChildAllocation => ({ childId, parentId, qty });

  test("single-parent allocation: produces parent + one child row", () => {
    const result = expandChildAllocations(
      [booking(10), booking(20)],
      [alloc(20, 10, 1)],
    );
    // parent row (listing 10) + expanded child row (listing 20 under 10).
    expect(result).toHaveLength(2);
    const parentRow = result.find((r) => r.listingId === 10)!;
    const childRow = result.find((r) => r.listingId === 20)!;
    expect(parentRow.parentListingId ?? 0).toBe(0);
    expect(childRow.parentListingId).toBe(10);
    // All rows share one token.
    expect(parentRow.orderToken).toBeTruthy();
    expect(childRow.orderToken).toBe(parentRow.orderToken);
  });

  test("two-parent allocation: child under each parent → 4 rows", () => {
    // One parent-A row, one parent-B row, two child rows (one per parent).
    const result = expandChildAllocations(
      [booking(10), booking(20), booking(30, 2)],
      [alloc(30, 10, 1), alloc(30, 20, 1)],
    );
    // Parent A (10) + parent B (20) + child under 10 + child under 20 = 4.
    expect(result).toHaveLength(4);
    const childRows = result.filter((r) => r.listingId === 30);
    expect(childRows).toHaveLength(2);
    const parentIds = childRows.map((r) => r.parentListingId);
    expect(parentIds).toContain(10);
    expect(parentIds).toContain(20);
    // Each child allocation carries qty 1.
    expect(childRows.every((r) => r.quantity === 1)).toBe(true);
    // All rows share one token.
    const token = result[0]!.orderToken;
    expect(result.every((r) => r.orderToken === token)).toBe(true);
  });

  test("proportional pricePaid split across allocations", () => {
    // Child booking has pricePaid=100, split 1:3 across two allocations.
    const result = expandChildAllocations(
      [booking(10), booking(20, 4, 100)],
      [alloc(20, 10, 1), alloc(20, 10, 3)],
    );
    const childRows = result.filter((r) => r.listingId === 20);
    expect(childRows).toHaveLength(2);
    // 100 * 1 / 4 = 25; 100 * 3 / 4 = 75.
    const prices = childRows.map((r) => r.pricePaid).sort((a, b) => a! - b!);
    expect(prices).toEqual([25, 75]);
  });

  test("standalone listing (no allocation) gets only the orderToken", () => {
    // Listing 99 has no allocation entry — it's a standalone row.
    const result = expandChildAllocations([booking(99)], []);
    expect(result).toHaveLength(1);
    expect(result[0]!.orderToken).toBeTruthy();
    expect(result[0]!.parentListingId ?? 0).toBe(0);
  });

  test("booking without explicit quantity defaults to 1 for price split", () => {
    // A ListingBooking whose quantity is absent; the ?? 1 guard must treat it
    // as 1 so price-paid proportioning doesn't divide by undefined.
    const noQty: import("#shared/db/attendee-types.ts").ListingBooking = {
      listingId: 20,
      pricePaid: 60,
    };
    const result = expandChildAllocations([noQty], [alloc(20, 10, 1)]);
    expect(result).toHaveLength(1);
    // qty from alloc; pricePaid = 60 * 1 / 1 = 60.
    expect(result[0]!.quantity).toBe(1);
    expect(result[0]!.pricePaid).toBe(60);
  });

  test("un-allocated units become a parent-less remainder row", () => {
    // Booking of 3 units, but only 1 is allocated under a parent — the other 2
    // were bought standalone in the same order (reachable once a child is
    // bookable on its own). The remainder must NOT be dropped: it becomes one
    // parent-less row so no unit vanishes.
    const result = expandChildAllocations(
      [booking(20, 3, 90)],
      [alloc(20, 10, 1)],
    );
    expect(result).toHaveLength(2);
    const allocRow = result.find((r) => r.parentListingId === 10)!;
    const remainderRow = result.find((r) => (r.parentListingId ?? 0) === 0)!;
    expect(allocRow.quantity).toBe(1);
    expect(remainderRow.quantity).toBe(2);
    // pricePaid split by quantity: 90*1/3 = 30 on the alloc, the rest (60) on
    // the remainder (which absorbs the residue). Total conserved.
    expect(allocRow.pricePaid).toBe(30);
    expect(remainderRow.pricePaid).toBe(60);
    expect(allocRow.pricePaid! + remainderRow.pricePaid!).toBe(90);
    // Both rows share the one order token.
    expect(remainderRow.orderToken).toBe(allocRow.orderToken);
  });

  test("an odd fully-allocated split conserves pricePaid to the cent", () => {
    // 100 across three single-unit allocations rounds to 33/33/33 = 99 under a
    // naive per-row round; the last row must absorb the residual penny (→ 34)
    // so ledger/email totals never drift.
    const result = expandChildAllocations(
      [booking(20, 3, 100)],
      [alloc(20, 10, 1), alloc(20, 30, 1), alloc(20, 40, 1)],
    );
    const prices = result.map((r) => r.pricePaid!).sort((a, b) => a - b);
    expect(prices).toEqual([33, 33, 34]);
    expect(prices.reduce((a, b) => a + b, 0)).toBe(100);
  });

  test("a free (price-less) remainder row carries no pricePaid", () => {
    // No pricePaid on the booking → neither the allocation row nor the
    // remainder row gains one (the ?? 1 / undefined guards hold).
    const result = expandChildAllocations([booking(20, 3)], [alloc(20, 10, 1)]);
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.pricePaid === undefined)).toBe(true);
    expect(result.map((r) => r.quantity).sort()).toEqual([1, 2]);
  });
});
