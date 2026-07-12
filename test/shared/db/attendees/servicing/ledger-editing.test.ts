// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { costAccount } from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { formatCurrency } from "#shared/currency.ts";
import { getServicingCosts } from "#shared/db/attendees/servicing.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  adminPost,
  createServicingHold,
  editServiceCost,
  listingCostOf,
  recordServiceCost,
  renderAdminPage,
} from "#test-utils/servicing.ts";
import {
  editBoilerCostTo,
  recordBoilerCost,
  SERVICE_DATE,
  transfersOfKind,
} from "#test-utils/servicing-ledger.ts";

// jscpd:ignore-end

describeWithEnv("servicing §22 - editing costs", { db: true }, () => {
  test("editing a cost posts a correcting adjustment, never mutates a row", async () => {
    const { afterRows, beforeRows, listing } = await editBoilerCostTo(6000);
    expect(afterRows).toBe(beforeRows + 1);
    expect(await listingCostOf(listing.id)).toBe(6000);
    const legs = await transfersByAccount(costAccount(listing.id));
    expect(legs.length).toBeGreaterThanOrEqual(2);
  });

  test("editing a cost to the same amount is a no-op", async () => {
    const { afterRows, beforeRows, listing } = await editBoilerCostTo(9000);
    expect(afterRows).toBe(beforeRows);
    expect(await listingCostOf(listing.id)).toBe(9000);
  });

  test("raising a cost posts a positive cost adjustment", async () => {
    const { id, listing } = await editBoilerCostTo(12000);
    expect(await listingCostOf(listing.id)).toBe(12000);
    const legs = await transfersByAccount(costAccount(listing.id));
    expect(legs.map((leg) => leg.amount).toSorted()).toEqual([3000, 9000]);
    const costs = await getServicingCosts(id);
    expect(costs[0]!.amount).toBe(12000);
  });

  test("editing a prior cost-reduction leg resolves the listing from the destination account", async () => {
    const { listing } = await editBoilerCostTo(6000);
    const reduction = (await transfersOfKind(KIND.serviceCost)).find(
      (leg) => leg.destination.type === "cost",
    );
    if (!reduction) throw new Error("missing cost reduction leg");

    await editServiceCost(reduction.id, { amount: 1000 });

    expect(await listingCostOf(listing.id)).toBe(4000);
  });

  test("the service-cost edit route posts a correcting delta for that event", async () => {
    const { id, listing } = await createServicingHold();
    const costId = await recordBoilerCost(id, listing.id);
    const response = await adminPost(`/admin/servicing/${id}/cost/${costId}`, {
      amount: "60.00",
    });
    expect(response.headers.get("location")).toContain(
      `/admin/servicing/${id}`,
    );
    expect(await listingCostOf(listing.id)).toBe(6000);
  });

  test("editing a recorded cost updates the listed amount", async () => {
    const { id, listing } = await createServicingHold();
    const costId = await recordServiceCost({
      amount: 9000,
      listingId: listing.id,
      memo: "Boiler part",
      occurredAt: SERVICE_DATE,
      servicingId: id,
    });
    await editServiceCost(costId, { amount: 6000 }, id);
    const costs = await getServicingCosts(id);
    expect(costs).toHaveLength(1);
    expect(costs[0]!.amount).toBe(6000);
    expect(costs[0]!.id).toBe(costId);
    expect(costs[0]!.memo).toBe("Boiler part");
    const body = await renderAdminPage(`/admin/servicing/${id}`);
    expect(body).toContain(formatCurrency(6000));
    expect(body).not.toContain(formatCurrency(9000));
  });

  test("a second sequential edit uses the current adjusted amount, not the original", async () => {
    const { listing } = await editBoilerCostTo(6000, 5000);
    expect(await listingCostOf(listing.id)).toBe(5000);
  });

  test("a sequential edit after an increase accumulates the positive adjustment leg correctly", async () => {
    const { listing } = await editBoilerCostTo(12000, 10000);
    expect(await listingCostOf(listing.id)).toBe(10000);
  });

  test("editing back to a previously-used target amount after an intermediate edit applies the correct delta", async () => {
    const { listing } = await editBoilerCostTo(6000, 7000, 6000);
    expect(await listingCostOf(listing.id)).toBe(6000);
  });

  test("an operator memo matching the old internal adjustment pattern is not misidentified as an adjustment", async () => {
    const { id, listing } = await createServicingHold();
    const costId = await recordServiceCost({
      amount: 9000,
      listingId: listing.id,
      memo: `edit service cost ${id}`,
      occurredAt: SERVICE_DATE,
      servicingId: id,
    });
    await editServiceCost(costId, { amount: 6000 });
    expect(await listingCostOf(listing.id)).toBe(6000);
    const costs = await getServicingCosts(id);
    expect(costs[0]!.amount).toBe(6000);
  });
});
