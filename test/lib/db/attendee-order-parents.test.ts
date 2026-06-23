import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { ListingBooking } from "#shared/db/attendee-types.ts";
import { annotateOrderParents } from "#shared/db/attendees/order-parents.ts";
import { setChildIds } from "#shared/db/listing-parents.ts";
import { createTestListing, describeWithEnv } from "#test-utils";

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
    await setChildIds(parent.id, [child.id]);

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
    await setChildIds(parent.id, [child.id]);

    const result = await annotateOrderParents([line(child.id)]);
    expect(result).toEqual([line(child.id)]);
  });

  test("records the first in-order parent for a child shared by two parents", async () => {
    // The rare multi-parent corner: the summed child row holds one parent, the
    // first whose listing is booked in the order.
    const parentA = await createTestListing({ name: "Base A" });
    const parentB = await createTestListing({ name: "Base B" });
    const child = await createTestListing({ name: "Shared add-on" });
    await setChildIds(parentA.id, [child.id]);
    await setChildIds(parentB.id, [child.id]);

    const result = await annotateOrderParents([
      line(parentA.id),
      line(parentB.id),
      line(child.id),
    ]);
    const childRow = result.find((b) => b.listingId === child.id)!;
    expect([parentA.id, parentB.id]).toContain(childRow.parentListingId);
  });
});
