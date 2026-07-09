import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { Listing } from "#shared/types.ts";
import {
  createTestGroup,
  describeWithEnv,
  makeParent,
  ticketGet,
} from "#test-utils";

/** Build the "ungrouped parent whose two children share ONE capped child-only
 *  group" scenario: only the child-cap (`cap`) and the parent's max quantity
 *  (`parentMaxQuantity`) vary between the 1-spot and 3-spot rows — the rest of
 *  the spec is identical — so this curry carries the two varying parts. */
const parentWithChildrenSharingCappedGroup = (
  cap: number,
  parentMaxQuantity: number,
): Promise<{ parent: Listing }> => {
  return (async () => {
    const childGroup = await createTestGroup({
      maxAttendees: cap,
      name: "Add-on pool",
    });
    return makeParent({
      children: [
        { groupId: childGroup.id, maxAttendees: 50, maxQuantity: 5 },
        { groupId: childGroup.id, maxAttendees: 50, maxQuantity: 5 },
      ],
      parent: { maxAttendees: 50, maxQuantity: parentMaxQuantity },
    });
  })();
};

describeWithEnv(
  "server > parents booking — quantity clamp on render",
  { db: true, triggers: true },
  () => {
    // Table-driven: the parent-quantity clamp / group-cap render cluster. Each
    // row builds a scenario, renders the parent's booking page, isolates the
    // `quantity_<parent.id>` <select>, and asserts which quantity options it
    // offers (`contains`) and rejects (`notContains`). The setup varies — some
    // rows pre-create a separate child-only group — so each row supplies its own
    // async `setup`; the comment on each documents the invariant it protects.
    const QUANTITY_CLAMP_CASES: {
      name: string;
      setup: () => Promise<{ parent: Listing }>;
      contains: string;
      notContains: string[];
    }[] = [
      {
        contains: '"1"',
        // The parent offers up to 5, but its single auto-selected child is capped
        // at 1, so child quantity (slaved to the parent) can only be 1 — the page
        // must offer only quantity 0–1, not 2–5 the submit fold would reject.
        name: "a parent's quantity is clamped to a single child's capacity",
        notContains: ['"2"', '"5"'],
        setup: () =>
          makeParent({
            children: [{ maxAttendees: 50, maxQuantity: 1 }],
            parent: { maxAttendees: 50, maxQuantity: 5 },
          }),
      },
      {
        contains: '"3"',
        // With the child capped at 3, the parent offering 5 must offer up to 3 and
        // no higher.
        name: "a parent's quantity is clamped to a child capped at three",
        notContains: ['"4"', '"5"'],
        setup: () =>
          makeParent({
            children: [{ maxAttendees: 50, maxQuantity: 3 }],
            parent: { maxAttendees: 50, maxQuantity: 5 },
          }),
      },
      {
        contains: '"1"',
        // Parent and its only child share a capped group, so each order consumes
        // TWO group spots (parent + auto-selected child). With two spots free the
        // selector must offer quantity 1 and never 2, which the submit-side
        // combined-demand check would reject.
        name: "a parent + child sharing a capped group with 2 spots offers only qty 1",
        notContains: ['"2"'],
        setup: () =>
          makeParent({
            children: [{ maxQuantity: 5 }],
            group: { maxAttendees: 2, name: "Pool" },
            parent: { maxQuantity: 5 },
          }),
      },
      {
        contains: '"2"',
        // With four shared spots free, two parent+child orders fit (four units), so
        // the selector offers up to quantity 2 and no higher.
        name: "a parent + child sharing a capped group with 4 spots offers up to qty 2",
        notContains: ['"3"'],
        setup: () =>
          makeParent({
            children: [{ maxQuantity: 5 }],
            group: { maxAttendees: 4, name: "Pool" },
            parent: { maxQuantity: 5 },
          }),
      },
      {
        contains: '"1"',
        // The parent is ungrouped, but its two children share ONE capped child-only
        // group with a single spot. Under per-unit selection 1-of-each consumes TWO
        // spots from that one pool, so only one combined order fits. The parent
        // quantity selector must offer 1 and never 2 — summing each child's own cap
        // (1 + 1 = 2) over-offered, and `checkBatchAvailability` would reject a 2.
        name: "an ungrouped parent + two children sharing a 1-spot capped group offers parent max 1",
        notContains: ['"2"'],
        setup: () => parentWithChildrenSharingCappedGroup(1, 5),
      },
      {
        contains: '"3"',
        // The same child-only capped group with three spots fits three child units
        // total across the two children, so the parent offers up to 3 and no higher
        // — proving the cohort is clamped by the pool's remaining (3), not summed
        // per child (5 + 5) and not floor-divided (this group has no parent in it).
        name: "an ungrouped parent + two children sharing a 3-spot capped group offers parent max 3",
        notContains: ['"4"'],
        setup: () => parentWithChildrenSharingCappedGroup(3, 9),
      },
      {
        contains: '"1"',
        // The shared group has 10 spots — `floor(10 / 2) = 5` parent+child orders
        // would fit the pool — but the single child itself caps at 1, so only ONE
        // order can actually be fulfilled. The parent quantity (which the sole child
        // is auto-filled to) must be clamped to 1, never offering 2 the submit fold
        // would reject. A naive shared-group cap that ignored the child's own
        // `maxPurchasable` would offer up to 5.
        name: "a parent + child sharing a big capped group is clamped by the child's own capacity",
        notContains: ['"2"'],
        setup: () =>
          makeParent({
            children: [{ maxAttendees: 50, maxQuantity: 1 }],
            group: { maxAttendees: 10, name: "Pool" },
            parent: { maxAttendees: 50, maxQuantity: 5 },
          }),
      },
    ];
    for (const c of QUANTITY_CLAMP_CASES) {
      test(c.name, async () => {
        const { parent } = await c.setup();
        const body = await (await ticketGet(parent.slug)).text();
        const select = body.slice(body.indexOf(`name="quantity_${parent.id}"`));
        const options = select.slice(0, select.indexOf("</select>"));
        expect(options).toContain(`value=${c.contains}`);
        for (const value of c.notContains) {
          expect(options).not.toContain(`value=${value}`);
        }
      });
    }

    test("a shared-group child's per-unit select is clamped by its own capacity", async () => {
      // With a second (separate-pool) child the shared child renders a per-unit
      // select. The shared group has 10 spots (floor(10/2)=5 orders), but the
      // shared child caps at 1, so its OWN select must offer max 1 — the separate
      // sibling absorbs the rest of the parent's quantity.
      const group = await createTestGroup({ maxAttendees: 10, name: "Pool" });
      const { parent, children } = await makeParent({
        children: [
          { groupId: group.id, maxAttendees: 50, maxQuantity: 1 },
          { maxAttendees: 50, maxQuantity: 3 },
        ],
        parent: { groupId: group.id, maxAttendees: 50, maxQuantity: 3 },
      });
      const shared = children[0]!;
      const body = await (await ticketGet(parent.slug)).text();
      const start = body.indexOf(`name="child_qty_${parent.id}_${shared.id}"`);
      expect(start).toBeGreaterThanOrEqual(0);
      const select = body.slice(start);
      const options = select.slice(0, select.indexOf("</select>"));
      expect(options).toContain('value="1"');
      expect(options).not.toContain('value="2"');
    });
  },
);
