/**
 * Servicing §22 — ledger integration: service costs & listing profit.
 *
 * A servicing hold is free, so creating one posts no sale/payment/fee legs. An
 * operator can record a cost against it (e.g. £90 for a boiler part): one
 * `cost:L → world` leg, `kind='service_cost'`, dated at the service date.
 * `cost(L) = −balanceOf(cost:L)` is the positive total of cost legs; profit is
 * `income(L) − cost(L)` (gross income preserved). Costs are append-only —
 * editing posts a correcting delta — and the `transfers` ledger is never
 * touched by a delete (servicing-event or listing). Cost legs remain as
 * orphaned history; the ledger UI shows "Deleted listing" for the unresolved
 * account label.
 *
 * Implementation contract (test-first):
 *   - `#shared/accounting/accounts.ts` exports `COST = "cost"` and
 *     `costAccount = rowAccount(COST)` (reuses the `rowAccount` id guard).
 *   - `#shared/accounting/projection.ts` exports pure `costOf(listingId)` and
 *     `profitOf(listingId)` readers over the `transfers` table; the pure
 *     projections `costProjection`/`profitProjection` live in
 *     `#shared/ledger/project.ts` (or a sibling) for unit testing.
 *   - `#shared/db/attendees/servicing.ts` (or a `servicing-cost.ts` sibling)
 *     exports `recordServiceCost`, `editServiceCost`. The delete path does NOT
 *     reverse cost legs — the ledger is append-only history and is never
 *     touched by a delete.
 *   - Transfer `kind='service_cost'`; the cost account is `cost:<listingId>`.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { costAccount, revenueAccount } from "#shared/accounting/accounts.ts";
import { costOf, profitOf } from "#shared/accounting/projection.ts";
import {
  accountBalance,
  allTransfers,
  transfersByAccount,
} from "#shared/accounting/queries.ts";
import { formatCurrency } from "#shared/currency.ts";
import { queryAll } from "#shared/db/client.ts";
import { account } from "#shared/ledger/account.ts";
import {
  adminPost,
  createServicingHold,
  createTestAttendeeDirect,
  createTestListing,
  deleteServicingEvent,
  describeWithEnv,
  editServiceCost,
  expectCostAfterRecording,
  expectRejects,
  recordServiceCost,
  renderAdminPage,
} from "#test-utils";

// jscpd:ignore-end

const SERVICE_DATE = "2026-07-01T00:00:00.000Z";

const transfersOfKind = async (kind: string) =>
  (await allTransfers()).filter((t) => t.kind === kind);

/** Record a £90 "Boiler part" cost against the servicing event. */
const recordBoilerCost = (servicingId: number, listingId: number) =>
  recordServiceCost({
    amount: 9000,
    listingId,
    memo: "Boiler part",
    occurredAt: SERVICE_DATE,
    servicingId,
  });

describe("servicing §22 — costAccount id validation (reuses rowAccount)", () => {
  test("costAccount rejects 0/negative/fractional ids (no phantom cost account)", () => {
    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => costAccount(bad)).toThrow();
    }
  });

  test("costAccount mints a cost:<id> account for a positive integer id", () => {
    expect(costAccount(5)).toEqual(account("cost", 5));
  });
});

describeWithEnv("servicing §22 — ledger integration", { db: true }, () => {
  test("creating a servicing event posts no sale, payment, or fee legs (never a sale)", async () => {
    const { listing } = await createServicingHold();
    const kinds = (await allTransfers()).map((t) => t.kind);
    expect(kinds).not.toContain("sale");
    expect(kinds).not.toContain("payment");
    expect(kinds).not.toContain("fee");
    expect(await accountBalance(revenueAccount(listing.id))).toBe(0);
  });

  test("recording a cost posts one cost:L → world leg, kind='service_cost', dated at the service date", async () => {
    const { id, listing } = await createServicingHold();
    await recordBoilerCost(id, listing.id);
    const costLegs = await transfersOfKind("service_cost");
    expect(costLegs.length).toBe(1);
    const leg = costLegs[0]!;
    expect(leg.source).toEqual(account("cost", listing.id));
    expect(leg.destination).toEqual(account("external", "world"));
    expect(leg.amount).toBe(9000);
    expect(leg.occurredAt).toBe(SERVICE_DATE);
  });

  test("cost(L) sums cost legs and is zero when there are none", async () => {
    const { id, listing } = await createServicingHold();
    expect(await costOf(listing.id)).toBe(0);
    await expectCostAfterRecording(id, listing.id, 9000, 9000);
  });

  test("profit(L) = income(L) − cost(L) (gross income preserved)", async () => {
    const { listing } = await createServicingHold();
    // £200 income from a real customer booking.
    const { attendee } = await createTestAttendeeDirect(
      listing.id,
      "Customer",
      "c@example.com",
    );
    const { postListingSale } = await import("#test-utils/ledger.ts");
    await postListingSale({
      attendeeId: attendee.id,
      gross: 20000,
      listingId: listing.id,
    });
    // £90 cost from the service event.
    const { id } = await createServicingHold({ listing: { name: "L" } });
    await expectCostAfterRecording(id, listing.id, 9000, 9000);
    expect(await accountBalance(revenueAccount(listing.id))).toBe(20000);
    expect(await profitOf(listing.id)).toBe(11000);
  });

  test("listing detail surfaces service costs and profit", async () => {
    const { listing } = await createServicingHold();
    const { attendee } = await createTestAttendeeDirect(
      listing.id,
      "Customer",
      "c@example.com",
    );
    const { postListingSale } = await import("#test-utils/ledger.ts");
    await postListingSale({
      attendeeId: attendee.id,
      gross: 20000,
      listingId: listing.id,
    });
    const { id } = await createServicingHold({ listing: { name: "L" } });
    await recordBoilerCost(id, listing.id);

    const html = await renderAdminPage(`/admin/listing/${listing.id}`);

    expect(html).toContain("Costs");
    expect(html).toContain(formatCurrency(9000));
    expect(html).toContain("Profit");
    expect(html).toContain(formatCurrency(11000));
  });

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
    expect((await transfersOfKind("service_cost")).length).toBe(1);
    expect(await costOf(listing.id)).toBe(9000);
  });

  test("editing a cost posts a correcting adjustment, never mutates a row", async () => {
    const { id, listing } = await createServicingHold();
    const costId = await recordBoilerCost(id, listing.id);
    const beforeRows = (await transfersOfKind("service_cost")).length;
    // Lower £90 → £60: a −3000 delta leg is posted; no row is UPDATEd.
    await editServiceCost(costId, { amount: 6000 });
    const afterRows = (await transfersOfKind("service_cost")).length;
    expect(afterRows).toBe(beforeRows + 1);
    expect(await costOf(listing.id)).toBe(6000);
    const legs = await transfersByAccount(costAccount(listing.id));
    expect(legs.length).toBeGreaterThanOrEqual(2);
  });

  test("editing a cost to the same amount is a no-op", async () => {
    const { id, listing } = await createServicingHold();
    const costId = await recordBoilerCost(id, listing.id);
    const beforeRows = (await transfersOfKind("service_cost")).length;
    await editServiceCost(costId, { amount: 9000 });
    expect((await transfersOfKind("service_cost")).length).toBe(beforeRows);
    expect(await costOf(listing.id)).toBe(9000);
  });

  test("raising a cost posts a positive cost adjustment", async () => {
    const { id, listing } = await createServicingHold();
    const costId = await recordBoilerCost(id, listing.id);
    await editServiceCost(costId, { amount: 12000 });
    expect(await costOf(listing.id)).toBe(12000);
    const legs = await transfersByAccount(costAccount(listing.id));
    expect(legs.map((leg) => leg.amount).toSorted()).toEqual([3000, 9000]);
  });

  test("editing a prior cost-reduction leg resolves the listing from the destination account", async () => {
    const { id, listing } = await createServicingHold();
    const costId = await recordBoilerCost(id, listing.id);
    await editServiceCost(costId, { amount: 6000 });
    const reduction = (await transfersOfKind("service_cost")).find(
      (leg) => leg.destination.type === "cost",
    );
    if (!reduction) throw new Error("missing cost reduction leg");

    await editServiceCost(reduction.id, { amount: 1000 });

    expect(await costOf(listing.id)).toBe(4000);
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
    expect(await costOf(listing.id)).toBe(9000);
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
    expect(await costOf(listing.id)).toBe(6000);
  });

  test("deleting a servicing event leaves its cost legs as append-only history", async () => {
    // The transfers ledger is append-only — deleting a servicing event does
    // NOT reverse or remove its cost legs. They remain as history, the same
    // way sale legs for a deleted listing remain. The ledger UI shows
    // "Deleted listing" for the unresolved account label.
    const { id, listing } = await createServicingHold();
    await recordBoilerCost(id, listing.id);
    expect(await costOf(listing.id)).toBe(9000);
    await deleteServicingEvent(id);
    // The cost legs are untouched — the original leg still exists.
    const legs = await transfersByAccount(costAccount(listing.id));
    expect(legs.length).toBe(1);
    expect(legs[0]!.amount).toBe(9000);
  });

  test("a cost line targets a listing the event actually holds (allocation rule)", async () => {
    const { id } = await createServicingHold({ name: "Held" });
    const other = await createTestListing({ maxAttendees: 10, name: "Other" });
    await expectRejects(
      recordServiceCost({
        amount: 9000,
        listingId: other.id,
        memo: "x",
        occurredAt: SERVICE_DATE,
        servicingId: id,
      }),
    );
  });

  test("editing a service cost cannot move it through another service event", async () => {
    const { id, listing } = await createServicingHold({ name: "Held" });
    await createTestListing({ maxAttendees: 10, name: "Other Listing" });
    const other = await createServicingHold({
      listing: { maxAttendees: 10, name: "Other Listing" },
      name: "Other",
    });
    const costId = await recordBoilerCost(id, listing.id);
    await expectRejects(
      editServiceCost(costId, { amount: 6000 }, other.id),
      /held listing/,
    );
  });

  test("recording a cost rejects non-positive and non-integer amounts", async () => {
    const { id, listing } = await createServicingHold();
    for (const amount of [0, -1, 1.5]) {
      await expectRejects(
        recordServiceCost({
          amount,
          listingId: listing.id,
          memo: "Bad cost",
          occurredAt: SERVICE_DATE,
          servicingId: id,
        }),
        /positive integer/,
      );
    }
  });

  test("editing a missing service cost reports not found", async () => {
    await expectRejects(
      editServiceCost(999_999, { amount: 1000 }),
      /not found/,
    );
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
      "SELECT memo FROM transfers WHERE kind = 'service_cost'",
    );
    for (const r of rows) {
      expect(r.memo ?? "").not.toContain("07700 900000");
    }
  });
});
