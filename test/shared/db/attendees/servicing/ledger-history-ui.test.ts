// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { costAccount } from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { formatCurrency } from "#shared/currency.ts";
import { queryAll } from "#shared/db/client.ts";
import { deleteListing } from "#shared/db/listings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  adminPost,
  createServicingHold,
  deleteServicingEvent,
  recordServiceCost,
  renderAdminPage,
} from "#test-utils/servicing.ts";
import { createTestManagerSession } from "#test-utils/session.ts";
import {
  listingCostOf,
  recordBoilerCost,
  SERVICE_DATE,
} from "./ledger-helpers.ts";

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
    for (const i of [2, 0, 3, 1]) {
      const day = `2026-07-0${i + 1}`;
      await recordServiceCost({
        amount: 1000 + i * 100,
        listingId: listing.id,
        memo: `memo-${day}`,
        occurredAt: `${day}T00:00:00.000Z`,
        servicingId: id,
      });
    }
    const { getServicingCosts } = await import(
      "#shared/db/attendees/servicing.ts"
    );
    const costs = await getServicingCosts(id);
    expect(costs.map((cost) => cost.date.slice(0, 10))).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-04",
    ]);
    expect(costs.map((cost) => cost.memo)).toEqual([
      "memo-2026-07-01",
      "memo-2026-07-02",
      "memo-2026-07-03",
      "memo-2026-07-04",
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
    for (const row of rows) {
      expect(row.memo ?? "").not.toContain("07700 900000");
    }
  });
});
