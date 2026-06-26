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

/** Post a £200 customer sale against `listingId` (the income side of a profit
 *  assertion, so cost/profit can be checked against real revenue). */
const postCustomerSale = async (listingId: number): Promise<void> => {
  const { attendee } = await createTestAttendeeDirect(
    listingId,
    "Customer",
    "c@example.com",
  );
  const { postListingSale } = await import("#test-utils/ledger.ts");
  await postListingSale({ attendeeId: attendee.id, gross: 20000, listingId });
};

/** Assert a cost POST was rejected as a recoverable form error (302 back to the
 *  event page) and landed no new `service_cost` leg. */
const expectCostFormError = async (
  response: Response,
  servicingId: number,
  before: number,
): Promise<void> => {
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toContain(
    `/admin/servicing/${servicingId}`,
  );
  expect((await transfersOfKind("service_cost")).length).toBe(before);
};

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
    await postCustomerSale(listing.id);
    // £90 cost from the service event.
    const { id } = await createServicingHold({ listing: { name: "L" } });
    await expectCostAfterRecording(id, listing.id, 9000, 9000);
    expect(await accountBalance(revenueAccount(listing.id))).toBe(20000);
    expect(await profitOf(listing.id)).toBe(11000);
  });

  test("profitOf matches the listing row profit after a refund (gross, not net)", async () => {
    // The listing row projects profit as recognised (gross) income − costs
    // (listingProfitSubquery). profitOf previously read the NET revenue balance
    // (`accountBalance(revenue) − cost`), so after a refund — which lowers the
    // net balance but not recognised income — it diverged from the listing row.
    // It now uses recognised income, matching the SQL and the revenue breakdown.
    const { postAttendeeRefund } = await import("#test-utils/ledger.ts");
    const listing = await createTestListing({ maxAttendees: 10, name: "L" });
    const { attendee } = await createTestAttendeeDirect(
      listing.id,
      "Customer",
      "c@example.com",
    );
    // A £200 sale, fully refunded: gross income 200 (sale credit), net 0.
    await postAttendeeRefund({
      attendeeId: attendee.id,
      gross: 20000,
      listingId: listing.id,
    });
    // A £90 servicing cost on the same listing.
    const { id } = await createServicingHold({ listing: { name: "L" } });
    await recordBoilerCost(id, listing.id);

    const {
      getListingWithCount,
      invalidateListingsCache,
      listingRevenueBreakdown,
    } = await import("#shared/db/listings.ts");
    invalidateListingsCache();
    const row = await getListingWithCount(listing.id);
    const breakdown = await listingRevenueBreakdown(listing.id);

    // Recognised income is gross (£200) — the refund drops the net balance to 0
    // but does NOT lower recognised income or the listing's profit.
    expect(breakdown.recognisedIncome).toBe(20000);
    expect(breakdown.netBalance).toBe(0);
    expect(await costOf(listing.id)).toBe(9000);
    expect(await profitOf(listing.id)).toBe(11000); // 200 − 90
    expect(row?.profit).toBe(11000); // SQL listingProfitSubquery (the listing row)
  });

  test("listing detail surfaces service costs and profit", async () => {
    const { listing } = await createServicingHold();
    await postCustomerSale(listing.id);
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

  test("a double-submit of the cost form records only one cost (idempotency key)", async () => {
    // The cost form carries a per-render idempotency key the route passes as
    // the ledger reference, so a browser retry / double-click of the same form
    // posts the cost once — not twice — even though each POST generates a fresh
    // occurredAt. A genuinely separate submission (fresh key) still posts.
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
    const retried = await postCost(key); // same form, double-submit
    expect(retried.status).toBe(302);
    expect((await transfersOfKind("service_cost")).length).toBe(1);
    expect(await costOf(listing.id)).toBe(9000);
    // A separate submission (fresh key) posts a second, independent cost.
    await postCost(crypto.randomUUID());
    expect((await transfersOfKind("service_cost")).length).toBe(2);
    expect(await costOf(listing.id)).toBe(18000);
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

  test("invalid create cost amounts write no service_cost transfer (form error, not 500)", async () => {
    // Empty, negative, non-numeric, and zero amounts must be rejected at the
    // route as a form-error redirect, never reach the ledger, and never 500.
    const { id, listing } = await createServicingHold();
    const before = (await transfersOfKind("service_cost")).length;
    for (const amount of ["", "-5", "abc", "0"]) {
      const response = await adminPost(`/admin/servicing/${id}`, {
        amount,
        memo: "Bad",
        target_listing_id: String(listing.id),
      });
      await expectCostFormError(response, id, before);
    }
    expect(await costOf(listing.id)).toBe(0);
  });

  test("an invalid create target_listing_id writes no service_cost transfer", async () => {
    const { id, listing } = await createServicingHold();
    const before = (await transfersOfKind("service_cost")).length;
    for (const target of ["", "abc", "0", "-3"]) {
      const response = await adminPost(`/admin/servicing/${id}`, {
        amount: "90.00",
        memo: "Bad",
        target_listing_id: target,
      });
      expect(response.status).toBe(302);
      expect((await transfersOfKind("service_cost")).length).toBe(before);
    }
    // listing.id is a positive int but the event does not hold a different
    // listing, so the allocation rule still blocks it (form error, no 500).
    const other = await createTestListing({ maxAttendees: 10, name: "Other" });
    const response = await adminPost(`/admin/servicing/${id}`, {
      amount: "90.00",
      memo: "Bad",
      target_listing_id: String(other.id),
    });
    expect(response.status).toBe(302);
    expect((await transfersOfKind("service_cost")).length).toBe(before);
    expect(await costOf(listing.id)).toBe(0);
  });

  test("invalid edit cost amounts write no service_cost transfer (form error, not 500)", async () => {
    const { id, listing } = await createServicingHold();
    const costId = await recordBoilerCost(id, listing.id);
    const before = (await transfersOfKind("service_cost")).length;
    for (const amount of ["", "-5", "abc", "0"]) {
      const response = await adminPost(
        `/admin/servicing/${id}/cost/${costId}`,
        { amount },
      );
      await expectCostFormError(response, id, before);
    }
    // The original £90 cost is untouched — no delta leg landed.
    expect(await costOf(listing.id)).toBe(9000);
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

  test("editServiceCost rejects non-positive and non-integer target amounts (defence-in-depth)", async () => {
    const { id, listing } = await createServicingHold();
    const costId = await recordBoilerCost(id, listing.id);
    for (const amount of [0, -1, 1.5]) {
      await expectRejects(
        editServiceCost(costId, { amount }),
        /positive integer/,
      );
    }
  });

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
    expect(body).toContain("Recorded costs");
    expect(body).toContain(formatCurrency(9000));
    expect(body).toContain("Boiler part");
    expect(body).toContain(listing.name);
    // The edit form targets the cost route with the cost's id.
    expect(body).toContain(`/admin/servicing/${id}/cost/`);
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
      "SELECT memo FROM transfers WHERE kind = 'service_cost'",
    );
    for (const r of rows) {
      expect(r.memo ?? "").not.toContain("07700 900000");
    }
  });
});
