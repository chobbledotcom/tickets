// jscpd:ignore-start
import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { costAccount } from "#accounting/accounts.ts";
import { KIND } from "#accounting/kinds.ts";
import { transfersByAccount } from "#accounting/queries.ts";
import { getServicingCosts } from "#db/attendees/servicing.ts";
import { queryAll } from "#db/client.ts";
import { deleteListing } from "#db/listings/delete.ts";
import { formatCurrency } from "#shared/currency.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  createServicingHold,
  deleteServicingEvent,
  listingCostOf,
  recordServiceCost,
  renderAdminPage,
} from "#test-utils/servicing.ts";
import {
  recordBoilerCost,
  SERVICE_DATE,
} from "#test-utils/servicing-ledger.ts";
import {
  adminFormPost,
  createTestManagerSession,
} from "#test-utils/session.ts";

// jscpd:ignore-end

describeWithEnv("servicing §22 - cost history and pages", { db: true }, () => {
  test("the servicing edit route records a cost from the cost form", async () => {
    const { id, listing } = await createServicingHold();
    const { response } = await adminFormPost(`/admin/servicing/${id}`, {
      amount: "90.00",
      memo: "Boiler part",
      target_listing_id: String(listing.id),
    });
    assertStringIncludes(
      response.headers.get("location") ?? "",
      `/admin/servicing/${id}`,
    );
    expect(await listingCostOf(listing.id)).toBe(9000);
  });

  test("deleting a servicing event leaves its cost legs as append-only history", async () => {
    const { id, listing } = await createServicingHold();
    await recordBoilerCost(id, listing.id);
    expect(await listingCostOf(listing.id)).toBe(9000);
    await deleteServicingEvent(id);
    const legs = await transfersByAccount(costAccount(listing.id));
    expect(legs.length).toBe(1);
    expect(legs[0]!.amount).toBe(9000);
  });

  test("the servicing edit page lists recorded costs with amount, listing, memo, and edit controls", async () => {
    const { id, listing } = await createServicingHold();
    await recordServiceCost({
      amount: 9000,
      listingId: listing.id,
      memo: "Boiler part",
      occurredAt: SERVICE_DATE,
      servicingId: id,
    });
    const body = await renderAdminPage(`/admin/servicing/${id}`);
    assertStringIncludes(body, "Service event costs");
    assertStringIncludes(body, formatCurrency(9000));
    assertStringIncludes(body, "Boiler part");
    assertStringIncludes(body, listing.name);
    assertStringIncludes(body, "Money out");
    assertStringIncludes(body, `href="/admin/ledger?listing=${listing.id}"`);
    assertStringIncludes(body, "View money changes");
    assertStringIncludes(body, `/admin/servicing/${id}/cost/`);
  });

  test("shows managers the outgoing without a forbidden ledger link", async () => {
    const { id, listing } = await createServicingHold();
    await recordBoilerCost(id, listing.id);
    const response = await awaitTestRequest(`/admin/servicing/${id}`, {
      cookie: await createTestManagerSession(),
    });
    const body = await response.text();
    assertStringIncludes(body, listing.name);
    assert(!body.includes(`/admin/ledger?listing=${listing.id}`));
    assert(!body.includes("View money changes"));
  });

  test("shows a deleted cost listing as plain text without a dead ledger link", async () => {
    const { id, listing } = await createServicingHold();
    await recordBoilerCost(id, listing.id);
    await deleteListing(listing.id);

    const body = await renderAdminPage(`/admin/servicing/${id}`);

    assertStringIncludes(body, "Deleted listing");
    assert(!body.includes(`/admin/ledger?listing=${listing.id}`));
    assert(!body.includes("View money changes"));
  });

  test("getServicingCosts returns records in (occurred_at, transfer_id) order with each memo on its own row", async () => {
    const { id, listing } = await createServicingHold();
    for (const { amount, day, memo } of [
      { amount: 1200, day: "2026-07-02", memo: "later" },
      { amount: 1000, day: "2026-07-01", memo: "first" },
      { amount: 1100, day: "2026-07-01", memo: "second" },
    ]) {
      await recordServiceCost({
        amount,
        listingId: listing.id,
        memo,
        occurredAt: `${day}T00:00:00.000Z`,
        servicingId: id,
      });
    }
    const costs = await getServicingCosts(id);
    expect(costs.map((cost) => cost.date.slice(0, 10))).toEqual([
      "2026-07-01",
      "2026-07-01",
      "2026-07-02",
    ]);
    expect(costs.map((cost) => cost.memo)).toEqual([
      "first",
      "second",
      "later",
    ]);
  });

  test("cost memos are stored encrypted, never plaintext PII in transfers", async () => {
    const { id, listing } = await createServicingHold();
    await recordServiceCost({
      amount: 9000,
      listingId: listing.id,
      memo: "Plumber Dave 07700 900000",
      occurredAt: SERVICE_DATE,
      servicingId: id,
    });
    const rows = await queryAll<{ memo: string | null }>(
      `SELECT memo FROM transfers WHERE kind = '${KIND.serviceCost}'`,
    );
    expect(rows).toHaveLength(1);
    const memo = rows[0]?.memo;
    if (memo === null || memo === undefined)
      throw new Error("Missing stored memo");
    assert(!memo.includes("Plumber Dave"));
    assert(!memo.includes("07700 900000"));
    assert(!memo.includes("Plumber Dave 07700 900000"));
  });
});
