// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeesRaw } from "#shared/db/attendees.ts";
import type { Listing } from "#shared/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  bookOneOfEachFold,
  bookParent,
  childField,
  expectFoldedLine,
  expectNoBooking,
  expectRejectedBooking,
  expectReserved,
  makeParent,
  makeTwoDefaultChildren,
  parentField,
} from "#test-utils/parents.ts";

// jscpd:ignore-end

describeWithEnv(
  "server > parents gate > quantity matching",
  { db: true, triggers: true },
  () => {
    test("a multi-child parent rejects when no child is chosen", async () => {
      // With several bookable children there is no auto-select, so submitting no
      // child units leaves the per-parent total at 0 — short of the parent's
      // quantity (1), so the per-unit "choose N more add-on(s)" rejection fires.
      const { parent } = await makeParent({
        children: [{}, {}],
        parent: { name: "Base unit" },
      });

      const res = await bookParent(parent.slug, parentField(parent, "1"));
      await expectRejectedBooking(
        res,
        parent.id,
        "Choose 1 more add-on for Base unit.",
      );
    });

    test("a multi-child parent accepts the chosen child and folds only it", async () => {
      const { parent, childA, childB } = await makeTwoDefaultChildren();

      const res = await bookParent(parent.slug, {
        ...parentField(parent, "1"),
        ...childField(parent, childB, "1"),
      });
      expectReserved(res);
      expect((await getAttendeesRaw(childB.id)).length).toBe(1);
      // The unchosen sibling is never booked.
      await expectNoBooking(childA);
    });

    test("parent qty 1 requires exactly one child unit (a sum of 1)", async () => {
      // With two bookable children and parent quantity 1, the buyer must choose
      // exactly one child unit in total; choosing none rejects, choosing one folds.
      const { parent, childA, childB } = await makeTwoDefaultChildren();

      const res = await bookParent(parent.slug, {
        ...parentField(parent, "1"),
        ...childField(parent, childA, "1"),
      });
      expectReserved(res);
      await expectFoldedLine(childA, 1);
      await expectNoBooking(childB);
    });

    test("parent qty 2 accepts two units of one child", async () => {
      // Per-unit model: 2 of one child satisfies a parent quantity of 2 (the old
      // "one child at the parent quantity" special case).
      const { parent, children } = await makeParent({
        children: [{ maxQuantity: 5 }, { maxQuantity: 5 }],
        parent: { maxQuantity: 5 },
      });
      const [childA, childB] = [children[0]!, children[1]!];

      const res = await bookParent(parent.slug, {
        ...parentField(parent, "2"),
        ...childField(parent, childA, "2"),
      });
      expectReserved(res);
      // One folded line of quantity 2, no line for the unchosen sibling.
      await expectFoldedLine(childA, 2);
      await expectNoBooking(childB);
    });

    test("parent qty 2 accepts one of each child (two folded lines)", async () => {
      // Per-unit model: a mix of 1 of child A + 1 of child B also satisfies a
      // parent quantity of 2, folding TWO distinct attendee lines (one each).
      const { parent, childA, childB } = await makeTwoDefaultChildren({
        maxQuantity: 5,
      });
      await bookOneOfEachFold(parent, childA, childB);
    });

    // Child-quantity validation rejections: each builds a 2-child parent named
    // "Base unit", posts a booking whose child quantities are invalid, and
    // asserts a 302 + flash + zero parent rows. Per-row fields cover the cases
    // that need a stranger listing or extra child-row assertions.
    type ParentResult = Awaited<ReturnType<typeof makeParent>>;
    type StrangerListing = Awaited<ReturnType<typeof createTestListing>>;
    const REJECTION_CASES: {
      name: string;
      children: NonNullable<
        NonNullable<Parameters<typeof makeParent>[0]>["children"]
      >;
      parent: { maxQuantity?: number; name: string };
      makeStranger?: boolean;
      // Build the posted quantity_*/child_qty_* fields from the resolved parent,
      // its children, and an optional stranger listing (for the not-a-child
      // case).
      postFields: (args: {
        parent: Listing;
        children: ParentResult["children"];
        stranger: StrangerListing | undefined;
      }) => Record<string, string>;
      flash: string;
      // The not-subtracted case also pins childA/childB to zero rows.
      extraChildIdsZero?: boolean;
    }[] = [
      // Parent quantity 2 but only 1 child unit chosen → "choose 1 more add-on".
      {
        children: [{}, {}],
        flash: "Choose 1 more add-on for Base unit.",
        name: "a child total below the parent quantity is rejected (choose more)",
        parent: { maxQuantity: 5, name: "Base unit" },
        postFields: ({ parent, children }) => ({
          ...parentField(parent, "2"),
          ...childField(parent, children[0]!, "1"),
        }),
      },
      // Parent quantity 1 but 2 child units chosen → too many.
      {
        children: [{ maxQuantity: 5 }, { maxQuantity: 5 }],
        flash: "Too many add-ons chosen for Base unit — remove 1 add-on.",
        name: "a child total above the parent quantity is rejected (too many)",
        parent: { maxQuantity: 5, name: "Base unit" },
        postFields: ({ parent, children }) => ({
          ...parentField(parent, "1"),
          ...childField(parent, children[0]!, "1"),
          ...childField(parent, children[1]!, "1"),
        }),
      },
      // A garbage `child_qty_*` value parses to 0, so a single-bookable-child
      // parent does NOT auto-select (a value was submitted) and the total falls
      // short of the parent quantity.
      {
        children: [{}, {}],
        flash: "Choose 1 more add-on for Base unit.",
        name: "a non-numeric child quantity is treated as zero (rejected as too few)",
        parent: { name: "Base unit" },
        postFields: ({ parent, children }) => ({
          ...parentField(parent, "1"),
          ...childField(parent, children[0]!, "abc"),
        }),
      },
      // A negative `child_qty_*` value must be clamped to 0 (only non-negative
      // integers are accepted), NOT folded as a negative that silently lowers the
      // running total to the parent quantity. Here childA="-1" and childB="2": if
      // the negative were honoured the total would be 1 and the booking would slip
      // through; clamped to 0 the total is 2, one over the parent quantity of 1.
      {
        children: [{}, {}],
        extraChildIdsZero: true,
        flash: "Too many add-ons chosen for Base unit — remove 1 add-on.",
        name: "a negative child quantity is treated as zero, not subtracted from the total",
        parent: { name: "Base unit" },
        postFields: ({ parent, children }) => ({
          ...parentField(parent, "1"),
          ...childField(parent, children[0]!, "-1"),
          ...childField(parent, children[1]!, "2"),
        }),
      },
      // Two bookable children, so no auto-select; a quantity submitted for a
      // stranger listing (not a child) must be rejected, never ignored — and the
      // valid total must not be reached by it.
      {
        children: [{}, {}],
        flash: "Please choose an option for Base unit.",
        makeStranger: true,
        name: "a positive quantity for a listing that is not a child of the parent is rejected",
        parent: { name: "Base unit" },
        postFields: ({ parent, stranger }) => ({
          ...parentField(parent, "1"),
          ...childField(parent, stranger!, "1"),
        }),
      },
    ];
    for (const c of REJECTION_CASES) {
      test(c.name, async () => {
        const { parent, children } = await makeParent({
          children: c.children,
          parent: c.parent,
        });
        const stranger = c.makeStranger
          ? await createTestListing({ name: "Stranger" })
          : undefined;

        const res = await bookParent(parent.slug, {
          ...c.postFields({ children, parent, stranger }),
        });
        await expectRejectedBooking(res, parent.id, c.flash);
        if (c.extraChildIdsZero) {
          const [childA, childB] = [children[0]!, children[1]!];
          await expectNoBooking(childA);
          await expectNoBooking(childB);
        }
      });
    }
  },
);
