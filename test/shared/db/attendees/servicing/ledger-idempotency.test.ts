// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { KIND } from "#shared/accounting/kinds.ts";
import { parseFlashCookie } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  adminPost,
  createServicingHold,
  expectRejects,
  recordServiceCost,
} from "#test-utils/servicing.ts";
import {
  listingCostOf,
  SERVICE_DATE,
  transfersOfKind,
} from "./ledger-helpers.ts";

// jscpd:ignore-end

describeWithEnv("servicing §22 - cost idempotency", { db: true }, () => {
  test("posting a cost is idempotent (same deterministic reference adds no second leg)", async () => {
    const { id, listing } = await createServicingHold();
    const ref = `cost-${id}-${listing.id}`;
    await recordServiceCost({
      amount: 9000,
      listingId: listing.id,
      memo: "Boiler part",
      occurredAt: SERVICE_DATE,
      reference: ref,
      servicingId: id,
    });
    await recordServiceCost({
      amount: 9000,
      listingId: listing.id,
      memo: "Boiler part",
      occurredAt: SERVICE_DATE,
      reference: ref,
      servicingId: id,
    });
    expect((await transfersOfKind(KIND.serviceCost)).length).toBe(1);
    expect(await listingCostOf(listing.id)).toBe(9000);
  });

  test("a double-submit of the cost form records once and reports a clean success (idempotency key)", async () => {
    const { id, listing } = await createServicingHold();
    const postCost = (idempotencyKey: string) =>
      adminPost(`/admin/servicing/${id}`, {
        amount: "90.00",
        cost_idempotency_key: idempotencyKey,
        memo: "Boiler part",
        target_listing_id: String(listing.id),
      });
    const key = crypto.randomUUID();
    await postCost(key);
    const retried = await postCost(key);
    expect(retried.status).toBe(302);
    expect(parseFlashCookie(retried).error).toBeUndefined();
    expect(parseFlashCookie(retried).success).toBeDefined();
    expect((await transfersOfKind(KIND.serviceCost)).length).toBe(1);
    expect(await listingCostOf(listing.id)).toBe(9000);
    await postCost(crypto.randomUUID());
    expect((await transfersOfKind(KIND.serviceCost)).length).toBe(2);
    expect(await listingCostOf(listing.id)).toBe(18000);
  });

  test("reusing an idempotency key with a changed amount errors, never a silent false success", async () => {
    const { id, listing } = await createServicingHold();
    const key = crypto.randomUUID();
    const postCost = (amount: string) =>
      adminPost(`/admin/servicing/${id}`, {
        amount,
        cost_idempotency_key: key,
        memo: "Boiler part",
        target_listing_id: String(listing.id),
      });
    await postCost("90.00");
    const changed = await postCost("50.00");
    expect((await transfersOfKind(KIND.serviceCost)).length).toBe(1);
    expect(await listingCostOf(listing.id)).toBe(9000);
    expect(parseFlashCookie(changed).success).toBeUndefined();
    expect(parseFlashCookie(changed).error).toBeDefined();
    const { getServicingCosts } = await import(
      "#shared/db/attendees/servicing.ts"
    );
    const costs = await getServicingCosts(id);
    expect(costs.map((cost) => cost.amount)).toEqual([9000]);
  });

  test("reusing an idempotency key with only the memo changed does not silently keep the old memo", async () => {
    const { id, listing } = await createServicingHold();
    const key = crypto.randomUUID();
    const postCost = (memo: string) =>
      adminPost(`/admin/servicing/${id}`, {
        amount: "90.00",
        cost_idempotency_key: key,
        memo,
        target_listing_id: String(listing.id),
      });
    await postCost("Original memo");
    const changed = await postCost("Edited memo");
    expect(changed.status).toBe(302);
    expect(parseFlashCookie(changed).success).toBeUndefined();
    const { getServicingCosts } = await import(
      "#shared/db/attendees/servicing.ts"
    );
    const costs = await getServicingCosts(id);
    expect(costs).toHaveLength(1);
    expect(costs[0]!.memo).toBe("Original memo");
  });

  test("recordServiceCost throws COST_REPLAY_MISMATCH when a stored reference's payload changed", async () => {
    const { id, listing } = await createServicingHold();
    const { COST_REPLAY_MISMATCH } = await import(
      "#shared/db/attendees/servicing.ts"
    );
    const base = {
      listingId: listing.id,
      memo: "Boiler part",
      occurredAt: SERVICE_DATE,
      reference: "reused-key",
      servicingId: id,
    };
    await recordServiceCost({ ...base, amount: 9000 });
    await expectRejects(
      recordServiceCost({ ...base, amount: 5000 }),
      new RegExp(COST_REPLAY_MISMATCH.slice(0, 20)),
    );
    expect((await transfersOfKind(KIND.serviceCost)).length).toBe(1);
    expect(await listingCostOf(listing.id)).toBe(9000);
  });
});
