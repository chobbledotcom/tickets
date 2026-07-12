/**
 * Servicing §22 — cost editing & correcting adjustments.
 *
 * Costs are append-only: editing a recorded cost never mutates a row, it posts
 * a correcting delta leg. The current amount is the original leg plus every
 * adjustment, so sequential edits accumulate correctly (a later edit measures
 * its delta against the *current* amount, not the original). Adjustment legs
 * are recognised by a NUL-prefixed machine memo, so an operator memo that looks
 * like the old machine text is never mistaken for an internal delta.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { costAccount } from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  adminPost,
  createServicingHold,
  editServiceCost,
  listingCostOf,
  recordServiceCost,
} from "#test-utils/servicing.ts";
import {
  recordBoilerCost,
  SERVICE_DATE,
  transfersOfKind,
} from "#test-utils/servicing-ledger.ts";

// jscpd:ignore-end

describeWithEnv(
  "servicing §22 — cost editing & adjustments",
  { db: true },
  () => {
    test("editing a cost posts a correcting adjustment, never mutates a row", async () => {
      const { id, listing } = await createServicingHold();
      const costId = await recordBoilerCost(id, listing.id);
      const beforeRows = (await transfersOfKind(KIND.serviceCost)).length;
      // Lower £90 → £60: a −3000 delta leg is posted; no row is UPDATEd.
      await editServiceCost(costId, { amount: 6000 });
      const afterRows = (await transfersOfKind(KIND.serviceCost)).length;
      expect(afterRows).toBe(beforeRows + 1);
      expect(await listingCostOf(listing.id)).toBe(6000);
      const legs = await transfersByAccount(costAccount(listing.id));
      expect(legs.length).toBeGreaterThanOrEqual(2);
    });

    test("editing a cost to the same amount is a no-op", async () => {
      const { id, listing } = await createServicingHold();
      const costId = await recordBoilerCost(id, listing.id);
      const beforeRows = (await transfersOfKind(KIND.serviceCost)).length;
      await editServiceCost(costId, { amount: 9000 });
      expect((await transfersOfKind(KIND.serviceCost)).length).toBe(beforeRows);
      expect(await listingCostOf(listing.id)).toBe(9000);
    });

    test("raising a cost posts a positive cost adjustment", async () => {
      const { id, listing } = await createServicingHold();
      const costId = await recordBoilerCost(id, listing.id);
      await editServiceCost(costId, { amount: 12000 });
      expect(await listingCostOf(listing.id)).toBe(12000);
      const legs = await transfersByAccount(costAccount(listing.id));
      expect(legs.map((leg) => leg.amount).toSorted()).toEqual([3000, 9000]);
      // The cost list's getServicingCosts derives the current amount from the
      // original leg + the increase adjustment (isIncrease=true path).
      const { getServicingCosts } = await import(
        "#shared/db/attendees/servicing.ts"
      );
      const costs = await getServicingCosts(id);
      expect(costs[0]!.amount).toBe(12000);
    });

    test("editing a prior cost-reduction leg resolves the listing from the destination account", async () => {
      const { id, listing } = await createServicingHold();
      const costId = await recordBoilerCost(id, listing.id);
      await editServiceCost(costId, { amount: 6000 });
      const reduction = (await transfersOfKind(KIND.serviceCost)).find(
        (leg) => leg.destination.type === "cost",
      );
      if (!reduction) throw new Error("missing cost reduction leg");

      await editServiceCost(reduction.id, { amount: 1000 });

      expect(await listingCostOf(listing.id)).toBe(4000);
    });

    test("the servicing edit route records a cost from the cost form", async () => {
      const { id, listing } = await createServicingHold();
      const response = await adminPost(`/admin/servicing/${id}`, {
        amount: "90.00",
        memo: "Boiler part",
        target_listing_id: String(listing.id),
      });
      expect(response.headers.get("location")).toContain(
        `/admin/servicing/${id}`,
      );
      expect(await listingCostOf(listing.id)).toBe(9000);
    });

    test("the service-cost edit route posts a correcting delta for that event", async () => {
      const { id, listing } = await createServicingHold();
      const costId = await recordBoilerCost(id, listing.id);
      const response = await adminPost(
        `/admin/servicing/${id}/cost/${costId}`,
        {
          amount: "60.00",
        },
      );
      expect(response.headers.get("location")).toContain(
        `/admin/servicing/${id}`,
      );
      expect(await listingCostOf(listing.id)).toBe(6000);
    });

    test("a second sequential edit uses the current adjusted amount, not the original", async () => {
      // Bug: editServiceCost computed delta against the original leg amount,
      // ignoring prior adjustments. A second edit would double-count the first
      // adjustment, undershooting the target.
      // Record £90, edit to £60 (delta −30), then edit again to £50 (delta −10).
      const { id, listing } = await createServicingHold();
      const costId = await recordBoilerCost(id, listing.id); // £90
      await editServiceCost(costId, { amount: 6000 }); // → £60; delta −30
      await editServiceCost(costId, { amount: 5000 }); // → £50; delta should be −10
      expect(await listingCostOf(listing.id)).toBe(5000);
    });

    test("a sequential edit after an increase accumulates the positive adjustment leg correctly", async () => {
      // Covers the source_type==='cost' branch in the adjLegs accumulator: when
      // the first edit is an increase (delta > 0) the posted adjustment leg has
      // source_type='cost', so the accumulator must ADD its amount (not negate).
      // Record £90, increase to £120 (delta +30), then edit to £100 (delta −20).
      const { id, listing } = await createServicingHold();
      const costId = await recordBoilerCost(id, listing.id); // £90
      await editServiceCost(costId, { amount: 12000 }); // → £120; delta +30
      await editServiceCost(costId, { amount: 10000 }); // → £100; delta should be −20
      expect(await listingCostOf(listing.id)).toBe(10000);
    });

    test("editing back to a previously-used target amount after an intermediate edit applies the correct delta", async () => {
      // 90→60 (−30), 60→70 (+10), 70→60 (−10): the third edit re-targets £60.
      // If the event key omits currentAmount, the third edit's eventGroup and
      // reference hash-collide with the first edit's (same costId + same target),
      // causing assertEventMatches to throw a LedgerConflictError.
      const { id, listing } = await createServicingHold();
      const costId = await recordBoilerCost(id, listing.id); // £90
      await editServiceCost(costId, { amount: 6000 }); // → £60; delta −30
      await editServiceCost(costId, { amount: 7000 }); // → £70; delta +10
      await editServiceCost(costId, { amount: 6000 }); // → £60; delta must be −10
      expect(await listingCostOf(listing.id)).toBe(6000);
    });

    test("an operator memo matching the old internal adjustment pattern is not misidentified as an adjustment", async () => {
      // Old machine memo: 'edit service cost <id>'. If an operator records a cost
      // with that exact text, the adjustment reader must not count it as an
      // internal delta (the new machine memo is NUL-prefixed: \x00svc_adj:<id>).
      const { id, listing } = await createServicingHold();
      const costId = await recordServiceCost({
        amount: 9000,
        listingId: listing.id,
        memo: `edit service cost ${id}`,
        occurredAt: SERVICE_DATE,
        servicingId: id,
      });
      await editServiceCost(costId, { amount: 6000 }); // correct delta = −3000
      expect(await listingCostOf(listing.id)).toBe(6000);
      const { getServicingCosts } = await import(
        "#shared/db/attendees/servicing.ts"
      );
      const costs = await getServicingCosts(id);
      expect(costs[0]!.amount).toBe(6000);
    });
  },
);
