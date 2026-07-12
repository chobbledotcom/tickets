/**
 * Servicing §22 — cost reader, display, and ledger visibility.
 *
 * What the operator sees: the servicing page lists recorded outgoings with a
 * ledger link (gated by admin level, and shown as plain text once the listing
 * is deleted); `getServicingCosts` returns records in `(occurred_at,
 * transfer_id)` order with each memo on its own row; memos are stored encrypted;
 * the cost route dates the leg to the service date; and a listing-filtered
 * ledger view includes that listing's cost legs, scoped to it alone.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { costAccount } from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import { visibleTransfers } from "#shared/accounting/queries.ts";
import { emptyRange } from "#shared/accounting/range.ts";
import { formatCurrency } from "#shared/currency.ts";
import { queryAll } from "#shared/db/client.ts";
import { deleteListing } from "#shared/db/listings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  adminPost,
  createDatedServicingScenario,
  createServicingHold,
  editServiceCost,
  recordServiceCost,
  renderAdminPage,
} from "#test-utils/servicing.ts";
import {
  recordBoilerCost,
  SERVICE_DATE,
  transfersOfKind,
} from "#test-utils/servicing-ledger.ts";
import { createTestManagerSession } from "#test-utils/session.ts";

// jscpd:ignore-end

describeWithEnv("servicing §22 — cost reader & display", { db: true }, () => {
  test("the servicing edit page lists recorded costs with amount, listing, memo, and edit controls", async () => {
    const { id, listing } = await createServicingHold();
    await recordServiceCost({
      amount: 9000,
      listingId: listing.id,
      memo: "Boiler part",
      occurredAt: "2026-07-01T00:00:00.000Z",
      servicingId: id,
    });
    const body = await renderAdminPage(`/admin/servicing/${id}`);
    expect(body).toContain("Recorded outgoings");
    expect(body).toContain(formatCurrency(9000));
    expect(body).toContain("Boiler part");
    expect(body).toContain(listing.name);
    expect(body).toContain("Money out");
    expect(body).toContain(`href="/admin/ledger?listing=${listing.id}"`);
    expect(body).toContain("View in ledger");
    // The edit form targets the cost route with the cost's id.
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
    expect(body).not.toContain("View in ledger");
  });

  test("shows a deleted cost listing as plain text without a dead ledger link", async () => {
    const { id, listing } = await createServicingHold();
    await recordBoilerCost(id, listing.id);
    await deleteListing(listing.id);

    const body = await renderAdminPage(`/admin/servicing/${id}`);

    expect(body).toContain("Deleted listing");
    expect(body).not.toContain(`/admin/ledger?listing=${listing.id}`);
    expect(body).not.toContain("View in ledger");
  });

  test("getServicingCosts returns records in (occurred_at, transfer_id) order with each memo on its own row", async () => {
    // Ordering contract: the reader must return records in the SQL
    // ORDER BY occurred_at, transfer_id — not the order its concurrent decrypt()
    // calls happen to resolve in. Building the result as a pure
    // Promise.all(records.map(...)) preserves the query order by construction;
    // the earlier push()-into-shared-array form leaned on crypto-op scheduling.
    // Dates are scrambled vs insertion order, so a reader that skips the re-sort
    // (or drifts a decrypted memo onto the wrong record) fails here.
    const { id, listing } = await createServicingHold();
    // Insertion order (and thus ascending transfer_id) is scrambled vs date,
    // and TWO costs share 2026-07-01 so the secondary transfer_id tie-break is
    // exercised — not just the date sort. `early`/`late` are inserted in that
    // order, so under (occurred_at, transfer_id) `early` must precede `late`.
    const inserts = [
      { memo: "second-day", occurredAt: "2026-07-02" },
      { memo: "first-day-early", occurredAt: "2026-07-01" },
      { memo: "first-day-late", occurredAt: "2026-07-01" },
      { memo: "third-day", occurredAt: "2026-07-03" },
    ];
    for (const [i, cost] of inserts.entries()) {
      await recordServiceCost({
        amount: 1000 + i * 100,
        listingId: listing.id,
        memo: cost.memo,
        occurredAt: `${cost.occurredAt}T00:00:00.000Z`,
        servicingId: id,
      });
    }
    const { getServicingCosts } = await import(
      "#shared/db/attendees/servicing.ts"
    );
    const costs = await getServicingCosts(id);
    expect(costs.map((c) => c.date.slice(0, 10))).toEqual([
      "2026-07-01",
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
    ]);
    // Each record keeps its own memo — proving a row wasn't re-sorted by date
    // while its decrypted memo drifted onto a different record, and that the
    // same-date pair holds insertion (transfer_id) order.
    expect(costs.map((c) => c.memo)).toEqual([
      "first-day-early",
      "first-day-late",
      "second-day",
      "third-day",
    ]);
  });

  test("editing a recorded cost updates the listed amount", async () => {
    const { id, listing } = await createServicingHold();
    const costId = await recordServiceCost({
      amount: 9000,
      listingId: listing.id,
      memo: "Boiler part",
      occurredAt: "2026-07-01T00:00:00.000Z",
      servicingId: id,
    });
    await editServiceCost(costId, { amount: 6000 }, id);
    // Directly exercise the reader so the adjustment's branches are covered:
    // the original leg is an increase (base = amount), and the edit's adjustment
    // leg is a reduction (delta = -amount), so the net reads £60.
    const { getServicingCosts } = await import(
      "#shared/db/attendees/servicing.ts"
    );
    const costs = await getServicingCosts(id);
    expect(costs).toHaveLength(1);
    expect(costs[0]!.amount).toBe(6000);
    expect(costs[0]!.id).toBe(costId);
    expect(costs[0]!.memo).toBe("Boiler part");
    // The rendered page also shows the adjusted amount.
    const body = await renderAdminPage(`/admin/servicing/${id}`);
    expect(body).toContain(formatCurrency(6000));
    expect(body).not.toContain(formatCurrency(9000));
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
    for (const r of rows) {
      // The memo column is a stored (encrypted) string, never NULL — assert
      // that shape directly rather than defaulting a missing value away.
      const raw = r.memo;
      expect(raw).toEqual(expect.any(String));
      // Non-blank, and neither the PII substring nor the full
      // operator-entered memo appears in plaintext.
      expect(raw).not.toBe("");
      expect(raw).not.toContain("07700 900000");
      expect(raw).not.toContain("Plumber Dave");
      expect(raw).not.toBe("Plumber Dave 07700 900000");
    }
  });

  test("the cost route dates the cost leg to the service event date, not the submit time", async () => {
    // The route must set occurredAt from the event's booking date, not the
    // server clock — otherwise cost legs are dated when the form was submitted,
    // not when the work was done.
    const { id, listing } = await createDatedServicingScenario();
    await adminPost(`/admin/servicing/${id}`, {
      amount: "90.00",
      memo: "Boiler part",
      target_listing_id: String(listing.id),
    });
    const legs = await transfersOfKind(KIND.serviceCost);
    expect(legs.length).toBe(1);
    expect(legs[0]!.occurredAt).toBe("2026-07-01T00:00:00.000Z");
  });

  test("service_cost legs appear in the listing-filtered visible ledger, scoped to that listing", async () => {
    // Verifies that revenueLegScope includes cost-account legs so operators can
    // see service costs when they filter the ledger by listing — and that the
    // filter is scoped: another listing's cost must not leak in.
    // Pre-create both listings so createServicingHold resolves each by name —
    // its resolver otherwise reuses the sole existing listing, collapsing the
    // two costs onto one listing.
    const listing = await createTestListing({
      maxAttendees: 10,
      name: "Filtered",
    });
    await createTestListing({ maxAttendees: 10, name: "Other" });
    const { id } = await createServicingHold({ listing: { name: "Filtered" } });
    await recordBoilerCost(id, listing.id); // £90 on `listing`
    const other = await createServicingHold({ listing: { name: "Other" } });
    await recordBoilerCost(other.id, other.listing.id); // £90 on a different listing

    const legs = await visibleTransfers(emptyRange, [listing.id], 100);
    const costLegs = legs.filter((t) => t.kind === KIND.serviceCost);
    // Exactly this listing's cost leg — the other listing's is excluded.
    expect(costLegs).toHaveLength(1);
    expect(costLegs[0]!.source).toEqual(costAccount(listing.id));
  });
});
