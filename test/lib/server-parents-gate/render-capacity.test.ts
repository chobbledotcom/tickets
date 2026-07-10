// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { PARENT_CHILD_GROUP_UNITS } from "#shared/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  bookingPageHtml,
  bookOneOfEachFold,
  bookParent,
  childField,
  expectNoBooking,
  expectRejectedBooking,
  expectReserved,
  makeParent,
  makeRoomySharedChild,
  parentField,
} from "#test-utils/parents.ts";
import { expectRendersSoldOut, expectSelectOffers } from "./helpers.ts";

// jscpd:ignore-end

describeWithEnv(
  "server > parents gate > capacity & sold-out projection",
  { db: true, triggers: true },
  () => {
    test("a parent with no bookable child is rejected (sold out)", async () => {
      // A child with no capacity is not bookable, so the parent is sold out.
      const { parent } = await makeParent({
        children: [{ maxAttendees: 0 }],
        parent: { name: "Base unit" },
      });

      const res = await bookParent(parent.slug, parentField(parent, "1"));
      await expectRejectedBooking(
        res,
        parent.id,
        "Base unit has no available options right now.",
      );
    });

    test("child fields under a zero-quantity parent are ignored, not rejected", async () => {
      const { parent: parentA, child: childA } = await makeParent();
      const plain = await createTestListing({ name: "Plain" });

      // Book only the plain listing; the no-JS baseline submits parentA's child
      // controls at quantity 0 — they must be dropped, not fail the booking.
      const slugs = `${parentA.slug}+${plain.slug}`;
      const res = await bookParent(slugs, {
        ...parentField(parentA, "0"),
        ...parentField(plain, "1"),
        ...childField(parentA, childA, "1"),
      });
      expectReserved(res);
      expect((await getAttendeesRaw(plain.id)).length).toBe(1);
      // No child line was created for the un-booked parent.
      await expectNoBooking(childA);
    });

    test("a standard child sold out cumulatively still makes its parent render sold out", async () => {
      // A STANDARD child uses the date-less cumulative sold-out, which is correct
      // — a cumulatively full standard child leaves the parent with no bookable
      // child, so its page renders sold out (standard branch).
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({
        maxAttendees: 1,
        name: "Standard add-on",
      });
      await createTestAttendee(child.id, child.slug, "Buyer", "b@x.com");
      await listingChildren.setIds(parent.id, [child.id]);

      await expectRendersSoldOut(parent.slug, parent.id);
    });

    test("a parent + child in a 1-spot capped group renders sold out", async () => {
      // Parent and child share a capped group, so the minimum order consumes two
      // group spots. With one spot left, the booking page projects the parent to
      // sold out — matching the card and the submit-time rejection.
      const { group, parent } = await makeParent({
        group: { maxAttendees: 2, name: "Pool" },
      });
      const filler = await createTestListing({
        groupId: group!.id,
        name: "Filler",
      });
      await createTestAttendee(filler.id, filler.slug, "Buyer", "b@x.com");

      await expectRendersSoldOut(parent.slug, parent.id);
    });

    test("a parent + child in a 2-spot capped group renders a bookable form", async () => {
      // With two spots free the combined demand fits, so the parent renders a
      // normal quantity selector and child block.
      const { parent, child } = await makeParent({
        group: { maxAttendees: 2, name: "Pool" },
      });

      const html = await bookingPageHtml(parent.slug);
      expect(html).toContain(`name="quantity_${parent.id}"`);
      // The sole child is offered informationally (auto-selected), so it appears
      // in the child block but posts no `child_qty_*` field.
      expect(html).toContain(`data-sole-child="${child.id}"`);
    });

    test("a shared capped group caps the parent quantity selector by floor(remaining / units)", async () => {
      // Parent and child share a 3-spot capped group; each combined order consumes
      // PARENT_CHILD_GROUP_UNITS (2) spots, so only one combined order fits
      // (floor(3 / 2) = 1). The parent's own max_quantity is high enough (5) that
      // its standalone capacity (clamped to the 3 group spots) would otherwise show
      // a multi-option selector, so the rendered cap proves childTicketLimit divides
      // (not the child's own maxPurchasable, and not remaining + units): the
      // quantity selector offers a 1 option but never a 2.
      expect(PARENT_CHILD_GROUP_UNITS).toBe(2);
      const { parent } = await makeParent({
        children: [{ maxQuantity: 5 }],
        group: { maxAttendees: 3, name: "Pool3" },
        parent: { maxQuantity: 5 },
      });

      await expectSelectOffers(
        parent.slug,
        `quantity_${parent.id}`,
        ">1</option>",
        ">2</option>",
      );
    });

    test("a shared-group child's own qty select is capped by floor(remaining / units)", async () => {
      // The per-CHILD quantity select must be clamped by the child's own combined
      // order cap, not only by the parent total. Here a separate-pool sibling
      // (cap 5) lifts the parent total well above 1, so the parent ceiling no
      // longer masks the shared child's cap: the shared child's select must still
      // offer floor(3 / 2) = 1 — proving childTicketLimit DIVIDES the shared
      // remaining (not remaining + units, which would offer 5).
      expect(PARENT_CHILD_GROUP_UNITS).toBe(2);
      const group = await createTestGroup({ maxAttendees: 3, name: "Pool3" });
      const parent = await createTestListing({
        groupId: group.id,
        maxAttendees: 100,
        maxQuantity: 5,
        name: "Base unit",
      });
      // A separate-pool child with plenty of capacity, so the parent total is high.
      const sibling = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 5,
        name: "Add-on sibling",
      });
      // A child sharing the parent's 3-spot capped pool: floor(3 / 2) = 1.
      const sharedChild = await createTestListing({
        groupId: group.id,
        maxAttendees: 100,
        maxQuantity: 5,
        name: "Add-on shared",
      });
      await listingChildren.setIds(parent.id, [sibling.id, sharedChild.id]);

      await expectSelectOffers(
        parent.slug,
        `child_qty_${parent.id}_${sharedChild.id}`,
        ">1</option>",
        ">2</option>",
      );
    });

    test("two separate-pool children each cap 1 offer parent quantity up to 2", async () => {
      // Under per-unit distribution separate-pool children COMBINE: two children
      // each capped at 1 together serve a parent quantity of 2 (1 + 1). The old
      // per-child MAX wrongly clamped the parent selector to 1; summing them is
      // correct.
      const { parent } = await makeParent({
        children: [{ maxAttendees: 1 }, { maxAttendees: 1 }],
        parent: { maxAttendees: 100, maxQuantity: 5 },
      });

      await expectSelectOffers(
        parent.slug,
        `quantity_${parent.id}`,
        ">2</option>",
        ">3</option>",
      );
    });

    test("a 1+1 booking across two separate-pool children each cap 1 succeeds", async () => {
      // The fold accepts a parent quantity of 2 split 1 of A + 1 of B, which the
      // selector now offers — proving the combined-cap render matches the fold.
      const { parent, children } = await makeParent({
        children: [{ maxAttendees: 1 }, { maxAttendees: 1 }],
        parent: { maxAttendees: 100, maxQuantity: 5 },
      });
      const [childA, childB] = [children[0]!, children[1]!];
      await bookOneOfEachFold(parent, childA, childB);
    });

    test("two children sharing one capped group with the parent cap by combined demand, not naive sum", async () => {
      // Parent + both children share ONE capped group with 5 spots left. Each
      // combined order consumes PARENT_CHILD_GROUP_UNITS (2) spots regardless of
      // how many co-grouped children exist, so the parent ceiling is
      // floor(5 / 2) = 2 — NOT a naive per-child sum (which would over-offer).
      expect(PARENT_CHILD_GROUP_UNITS).toBe(2);
      const { parent } = await makeParent({
        children: [{ maxQuantity: 9 }, { maxQuantity: 9 }],
        group: { maxAttendees: 5, name: "Pool5" },
        parent: { maxQuantity: 9 },
      });

      await expectSelectOffers(
        parent.slug,
        `quantity_${parent.id}`,
        ">2</option>",
        ">3</option>",
      );
    });

    test("a child sharing a roomy group with the parent is NOT sold out by a tighter NON-shared group", async () => {
      // The child belongs to the parent's capped group A (10 spots) AND its own
      // tighter capped group B (1 spot). The shared-pool calc must use group A's
      // remaining (10) — the group it SHARES with the parent — not the child's
      // tightest group overall (B = 1). floor(10 / 2) = 5 ≥ 1, so a parent+child
      // order fits and the page renders a bookable form. The pre-fix code took the
      // child's per-listing minimum (1), computed floor(1 / 2) = 0, and wrongly
      // marked the parent sold out.
      const { parent } = await makeRoomySharedChild();

      const html = await bookingPageHtml(parent.slug);
      expect(html).not.toContain("Sorry, this listing is full.");
      expect(html).toContain(`name="quantity_${parent.id}"`);
    });

    test("two children sharing one capped group but differing OTHER memberships cap by that group", async () => {
      // Both children draw on capped group A with 1 spot left. Child1 is in {A},
      // Child2 in {A, B} (B is a roomy private group). They draw on the SAME pool
      // (A), so the parent quantity cap is min(1, Σ own caps) = 1 — NOT 2. The
      // pre-fix code bucketed by the WHOLE group-id set, so {A} and {A,B} landed in
      // different buckets and each contributed 1, over-offering a 2 the submit-time
      // checkBatchAvailability would reject.
      const groupA = await createTestGroup({ maxAttendees: 1, name: "PoolA" });
      const groupB = await createTestGroup({
        maxAttendees: 100,
        name: "PoolB",
      });
      const parent = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 5,
        name: "Base unit",
      });
      const childOne = await createTestListing({
        groupIds: [groupA.id],
        maxAttendees: 100,
        maxQuantity: 5,
        name: "Add-on one",
      });
      const childTwo = await createTestListing({
        groupIds: [groupA.id, groupB.id],
        maxAttendees: 100,
        maxQuantity: 5,
        name: "Add-on two",
      });
      await listingChildren.setIds(parent.id, [childOne.id, childTwo.id]);

      await expectSelectOffers(
        parent.slug,
        `quantity_${parent.id}`,
        ">1</option>",
        ">2</option>",
      );
    });

    test("a parent whose only child is sold out renders sold out on its own page", async () => {
      // On /ticket/<parent> the page must project a no-bookable-child parent to
      // sold out (no quantity selector / Book control), mirroring discovery,
      // instead of a normal form that could only fail at submit.
      const { parent } = await makeParent({ children: [{ maxAttendees: 0 }] });

      const html = await expectRendersSoldOut(parent.slug, parent.id);
      // No quantity selector / child selector is rendered for the parent.
      expect(html).not.toContain(`name="child_qty_${parent.id}_`);
    });
  },
);
