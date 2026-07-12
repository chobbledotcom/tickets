// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { costAccount } from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { formatCurrency } from "#shared/currency.ts";
import { getServicingCosts } from "#shared/db/attendees/servicing.ts";
import { queryAll } from "#shared/db/client.ts";
import { deleteListing } from "#shared/db/listings/delete.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  adminPost,
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
import { createTestManagerSession } from "#test-utils/session.ts";

// jscpd:ignore-end

describeWithEnv("servicing §22 - cost history and pages", { db: true }, () => {
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
    expect(body).toContain("Service event costs");
    expect(body).toContain(formatCurrency(9000));
    expect(body).toContain("Boiler part");
    expect(body).toContain(listing.name);
    expect(body).toContain("Money out");
    expect(body).toContain(`href="/admin/ledger?listing=${listing.id}"`);
    expect(body).toContain("View money history");
    expect(body).toContain(`/admin/servicing/${id}/cost/`);
  });

  test("shows managers the outgoing without a forbidden ledger link", async () => {
    const { id, listing } = await createServicingHold();
    await recordBoilerCost(id, listing.id);
    const response = await awaitTestRequest(`/admin/servicing/${id}`, {
      cookie: await createTestManagerSession(),
    });
    const body = await response.text();
    expect(body).toContain(listing.name);
    expect(body).not.toContain(`/admin/ledger?listing=${listing.id}`);
    expect(body).not.toContain("View money history");
  });

  test("shows a deleted cost listing as plain text without a dead ledger link", async () => {
    const { id, listing } = await createServicingHold();
    await recordBoilerCost(id, listing.id);
    await deleteListing(listing.id);

    const body = await renderAdminPage(`/admin/servicing/${id}`);

    expect(body).toContain("Deleted listing");
    expect(body).not.toContain(`/admin/ledger?listing=${listing.id}`);
    expect(body).not.toContain("View money history");
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
    expect(memo).not.toContain("Plumber Dave");
    expect(memo).not.toContain("07700 900000");
    expect(memo).not.toContain("Plumber Dave 07700 900000");
  });
});
