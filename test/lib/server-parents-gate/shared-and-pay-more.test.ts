// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeesRaw } from "#shared/db/attendees.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import type { Listing } from "#shared/types.ts";
import {
  bookParent,
  childField,
  createTestListing,
  describeWithEnv,
  expectRejectedBooking,
  expectReserved,
  makeParent,
  parentField,
  postCalculate,
} from "#test-utils";

// jscpd:ignore-end

/** Two maxQuantity-5 base listings "Base A"/"Base B" — the shared parent pair
 *  behind every shared-child test (so each re-creates the same pair without
 *  re-stating both `createTestListing` calls). */
const createBasePair = async (): Promise<{
  parentA: Listing;
  parentB: Listing;
}> => {
  const parentA = await createTestListing({ maxQuantity: 5, name: "Base A" });
  const parentB = await createTestListing({ maxQuantity: 5, name: "Base B" });
  return { parentA, parentB };
};

/** Wire one child as a child of BOTH parents — the shared parent→child edge pair
 *  behind every shared-child test. */
const shareChildOf = async (
  parentA: Listing,
  parentB: Listing,
  child: Listing,
): Promise<void> => {
  await listingChildren.setIds(parentA.id, [child.id]);
  await listingChildren.setIds(parentB.id, [child.id]);
};

/** A parent with a single pay-more child (max £50, base £10) — the shared
 *  scenario behind the pay-more price-fold and pay-more-below-minimum tests. */
const makePayMoreChild = () =>
  makeParent({
    children: [{ canPayMore: true, maxPrice: 5000, unitPrice: 1000 }],
  });

describeWithEnv(
  "server > parents gate > shared children & pay-more",
  { db: true, triggers: true },
  () => {
    test("a shared child under two parents produces one row per parent", async () => {
      // expandChildAllocations splits the fold into per-parent rows so
      // each row carries its true parentListingId rather than collapsing into one
      // summed row that loses the per-parent provenance.
      const { parentA, parentB } = await createBasePair();
      const child = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 10,
        name: "Shared add-on",
      });
      await shareChildOf(parentA, parentB, child);

      const slugs = `${parentA.slug}+${parentB.slug}`;
      const res = await bookParent(slugs, {
        ...parentField(parentA, "2"),
        ...parentField(parentB, "3"),
      });
      expectReserved(res);
      const childRows = await getAttendeesRaw(child.id);
      // Two rows: one for parentA (qty 2) and one for parentB (qty 3).
      expect(childRows.length).toBe(2);
      const totalQty = childRows.reduce((acc, r) => acc + r.quantity, 0);
      expect(totalQty).toBe(5);
    });

    test("a shared child over its capacity when summed is rejected (not clamped)", async () => {
      const { parentA, parentB } = await createBasePair();
      const child = await createTestListing({
        maxAttendees: 3,
        maxQuantity: 10,
        name: "Tight add-on",
      });
      await shareChildOf(parentA, parentB, child);

      const res = await bookParent(`${parentA.slug}+${parentB.slug}`, {
        ...parentField(parentA, "2"),
        ...parentField(parentB, "2"),
      });
      await expectRejectedBooking(res, parentA.id);
    });

    test("a pay-more child's submitted price is folded into the order", async () => {
      const { parent, child } = await makePayMoreChild();

      // The quote (no provider) surfaces the amount owed, which must include the
      // chosen pay-more child price (30.00), proving the child folded in.
      const html = await postCalculate(parent.slug, {
        ...parentField(parent, "1"),
        ...childField(parent, child, "1"),
        [`child_price_${parent.id}_${child.id}`]: "30.00",
      });
      // Tight match: the folded child adds £30 to the quote, but a regression
      // that doubled it (e.g. £300) must not slip through as a substring hit.
      expect(html).toContain("£30");
      expect(html).not.toContain("£300");
    });

    test("a shared pay-more child with mismatched prices is rejected", async () => {
      const { parentA, parentB } = await createBasePair();
      const child = await createTestListing({
        canPayMore: true,
        maxAttendees: 100,
        maxPrice: 9000,
        maxQuantity: 10,
        name: "Shared donation",
        unitPrice: 1000,
      });
      await shareChildOf(parentA, parentB, child);

      const res = await bookParent(`${parentA.slug}+${parentB.slug}`, {
        ...parentField(parentA, "1"),
        ...parentField(parentB, "1"),
        [`child_price_${parentA.id}_${child.id}`]: "20.00",
        [`child_price_${parentB.id}_${child.id}`]: "30.00",
      });
      await expectRejectedBooking(res, child.id);
    });

    test("a pay-more child below its minimum price is rejected", async () => {
      const { parent, child } = await makePayMoreChild();

      const res = await bookParent(parent.slug, {
        ...parentField(parent, "1"),
        ...childField(parent, child, "1"),
        [`child_price_${parent.id}_${child.id}`]: "1.00",
      });
      await expectRejectedBooking(res, parent.id);
    });
  },
);
