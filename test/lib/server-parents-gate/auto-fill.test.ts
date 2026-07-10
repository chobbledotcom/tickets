// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import {
  bookingPageHtml,
  bookParent,
  describeWithEnv,
  expectReserved,
  makeParent,
  parentField,
  postCalculate,
} from "#test-utils";

// jscpd:ignore-end

describeWithEnv(
  "server > parents gate > sole-child auto-fill",
  { db: true, triggers: true },
  () => {
    test("a single bookable child auto-selects and folds into a free booking", async () => {
      const { parent, child } = await makeParent({
        children: [{ maxQuantity: 5 }],
        parent: { maxQuantity: 5 },
      });

      const res = await bookParent(parent.slug, parentField(parent, "2"));
      expectReserved(res);

      const parentRows = await getAttendeesRaw(parent.id);
      const childRows = await getAttendeesRaw(child.id);
      expect(parentRows.length).toBe(1);
      expect(parentRows[0]?.quantity).toBe(2);
      // Child quantity follows the parent.
      expect(childRows.length).toBe(1);
      expect(childRows[0]?.quantity).toBe(2);
    });

    test("a sole child whose cap exceeds the chosen parent qty books at the parent qty", async () => {
      // When the sole child's cap (5) exceeds the chosen
      // parent quantity (1), the render must NOT post a fixed child quantity — that
      // would over-submit a total of 5 and the fold would reject it as 'too many'.
      // The page is informational and the fold auto-fills exactly Q (= 1).
      const { parent, child } = await makeParent({
        children: [{ maxQuantity: 5 }],
        parent: { maxQuantity: 5 },
      });

      // The rendered page emits no quantity field for the sole child.
      const html = await bookingPageHtml(parent.slug);
      expect(html).not.toContain(`name="child_qty_${parent.id}_${child.id}"`);

      // Booking the parent at quantity 1 succeeds (no 'too many').
      const res = await bookParent(parent.slug, parentField(parent, "1"));
      expectReserved(res);
      const childRows = await getAttendeesRaw(child.id);
      expect(childRows.length).toBe(1);
      // The fold auto-fills the sole child to the parent quantity (1), not the cap.
      expect(childRows[0]?.quantity).toBe(1);
    });

    test("the /calculate quote for a sole-child parent below the child cap succeeds", async () => {
      // The live quote runs the same fold; a form that posted the child's max as
      // the quantity would fail identically ('too many').
      const { parent } = await makeParent({
        children: [{ maxQuantity: 5, unitPrice: 500 }],
        parent: { maxQuantity: 5, unitPrice: 1000 },
      });

      const fragment = await postCalculate(
        parent.slug,
        parentField(parent, "1"),
      );
      // The quote succeeds (parent £10 + auto-filled child £5 = £15), not a 'too
      // many' rejection from an over-submitted child quantity.
      expect(fragment).not.toContain("Too many add-ons");
      expect(fragment).toContain("£15");
    });

    test("a sole pay-more child auto-fills and still collects its price without a posted qty", async () => {
      // The informational sole-child render posts NO `child_qty_*` field, yet the
      // pay-more price input is still rendered and the fold auto-fills the child
      // to the parent quantity and charges the submitted custom price.
      const { parent, child } = await makeParent({
        children: [
          { canPayMore: true, maxPrice: 5000, maxQuantity: 5, unitPrice: 1000 },
        ],
        parent: { maxQuantity: 5 },
      });

      // The quote includes the chosen pay-more child price (30.00) even though the
      // browser posts no quantity field for the sole child — auto-fill assigns Q.
      const html = await postCalculate(parent.slug, {
        ...parentField(parent, "1"),
        [`child_price_${parent.id}_${child.id}`]: "30.00",
      });
      expect(html).toContain("£30");
    });

    test("the /calculate quote includes the auto-selected child", async () => {
      const { parent } = await makeParent({
        children: [{ maxPrice: 0, unitPrice: 1500 }],
      });

      // Parent is free, child costs 15.00 — the quote must reflect the child.
      const html = await postCalculate(parent.slug, parentField(parent, "1"));
      expect(html).toContain("£15");
    });
  },
);
