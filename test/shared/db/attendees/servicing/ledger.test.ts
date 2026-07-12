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
 *   - Listing cost is read from the cost account balance, and listing profit
 *     comes from the same SQL row projection the admin page displays.
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
import { KIND } from "#shared/accounting/kinds.ts";
import { listingMoneyTotals } from "#shared/accounting/listing-money-totals.ts";
import {
  accountBalance,
  allTransfers,
  transfersByAccount,
  visibleTransfers,
} from "#shared/accounting/queries.ts";
import { emptyRange } from "#shared/accounting/range.ts";
import { formatCurrency } from "#shared/currency.ts";
import { queryAll } from "#shared/db/client.ts";
import { deleteListing } from "#shared/db/listings.ts";
import { account } from "#shared/ledger/account.ts";
import { parseFlashCookie } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  adminPost,
  createDatedServicingScenario,
  createServicingHold,
  deleteServicingEvent,
  editServiceCost,
  expectCostAfterRecording,
  expectRejects,
  listingCostOf,
  recordServiceCost,
  renderAdminPage,
} from "#test-utils/servicing.ts";
import { createTestManagerSession } from "#test-utils/session.ts";

// jscpd:ignore-end

const SERVICE_DATE = "2026-07-01T00:00:00.000Z";

const transfersOfKind = async (kind: string) =>
  (await allTransfers()).filter((t) => t.kind === kind);

const listingProfitOf = async (listingId: number): Promise<number> => {
  const { getListingWithCount, invalidateListingsCache } = await import(
    "#shared/db/listings.ts"
  );
  invalidateListingsCache();
  return (await getListingWithCount(listingId))!.profit;
};

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
  expect((await transfersOfKind(KIND.serviceCost)).length).toBe(before);
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
    const costLegs = await transfersOfKind(KIND.serviceCost);
    expect(costLegs.length).toBe(1);
    const leg = costLegs[0]!;
    expect(leg.source).toEqual(account("cost", listing.id));
    expect(leg.destination).toEqual(account("external", "world"));
    expect(leg.amount).toBe(9000);
    expect(leg.occurredAt).toBe(SERVICE_DATE);
  });

  test("cost(L) sums cost legs and is zero when there are none", async () => {
    const { id, listing } = await createServicingHold();
    expect(await listingCostOf(listing.id)).toBe(0);
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
    expect(await listingProfitOf(listing.id)).toBe(11000);
  });

  test("listing row profit stays gross after a refund", async () => {
    // The listing row projects profit as recognised (gross) income − costs
    // (listingProfitSubquery). An older reader used the NET revenue balance
    // (`accountBalance(revenue) − cost`), so after a refund — which lowers the
    // net balance but not recognised income — it diverged from the listing row.
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

    const { getListingWithCount, invalidateListingsCache } = await import(
      "#shared/db/listings.ts"
    );
    invalidateListingsCache();
    const row = await getListingWithCount(listing.id);
    const breakdown = await listingMoneyTotals(emptyRange, [listing.id]);

    // Recognised income is gross (£200) — the refund drops the net balance to 0
    // but does NOT lower recognised income or the listing's profit.
    expect(breakdown.recognisedIncome).toBe(20000);
    expect(breakdown.netBalance).toBe(0);
    expect(await listingCostOf(listing.id)).toBe(9000);
    expect(await listingProfitOf(listing.id)).toBe(11000); // 200 − 90
    expect(row?.profit).toBe(11000); // SQL listingProfitSubquery (the listing row)
  });

  test("listing detail surfaces service costs and profit", async () => {
    const { listing } = await createServicingHold();
    await postCustomerSale(listing.id);
    const { id } = await createServicingHold({ listing: { name: "L" } });
    await recordBoilerCost(id, listing.id);

    const html = await renderAdminPage(`/admin/listing/${listing.id}`);

    expect(html).toContain("Service event costs");
    expect(html).toContain(formatCurrency(9000));
    expect(html).toContain("Profit before refunds");
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
    expect((await transfersOfKind(KIND.serviceCost)).length).toBe(1);
    expect(await listingCostOf(listing.id)).toBe(9000);
  });

  test("a double-submit of the cost form records once and reports a clean success (idempotency key)", async () => {
    // The cost form carries a per-render idempotency key the route passes as the
    // ledger reference, so a browser retry / double-click of the same form posts
    // the cost once — not twice. The hold is DATELESS, so the route stamps a
    // fresh `occurredAt = new Date()` on each POST; the retry must still be
    // treated as a clean idempotent success (occurredAt is not compared), not an
    // error, which is the exact case the key exists to cover.
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
    // The retry is a success flash, NOT a COST_REPLAY_MISMATCH error.
    expect(parseFlashCookie(retried).error).toBeUndefined();
    expect(parseFlashCookie(retried).success).toBeDefined();
    expect((await transfersOfKind(KIND.serviceCost)).length).toBe(1);
    expect(await listingCostOf(listing.id)).toBe(9000);
    // A separate submission (fresh key) posts a second, independent cost.
    await postCost(crypto.randomUUID());
    expect((await transfersOfKind(KIND.serviceCost)).length).toBe(2);
    expect(await listingCostOf(listing.id)).toBe(18000);
  });

  test("reusing an idempotency key with a changed amount errors, never a silent false success", async () => {
    // Bug: recordServiceCost short-circuited on the stored reference without
    // checking the payload, so a reused key (e.g. a bfcached form the operator
    // edited before resubmitting) reported success for the NEW amount while
    // recording nothing. The second submit must either post the change or fail
    // — never silently keep the old £90 while claiming to record £50.
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
    const changed = await postCost("50.00"); // same key, different amount
    // Exactly one cost leg exists, and it is NOT a silent success storing £50.
    expect((await transfersOfKind(KIND.serviceCost)).length).toBe(1);
    expect(await listingCostOf(listing.id)).toBe(9000);
    // The distinguishing signal from the old false-success: the second submit
    // carries an ERROR flash, not a cost-recorded success flash.
    expect(parseFlashCookie(changed).success).toBeUndefined();
    expect(parseFlashCookie(changed).error).toBeDefined();
    const { getServicingCosts } = await import(
      "#shared/db/attendees/servicing.ts"
    );
    const costs = await getServicingCosts(id);
    expect(costs.map((c) => c.amount)).toEqual([9000]);
  });

  test("reusing an idempotency key with only the memo changed does not silently keep the old memo", async () => {
    // The cost reference derived from amount/listing/date omits the memo, so a
    // memo-only change under the same key would previously short-circuit and
    // preserve the stale memo while reporting success.
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
    const changed = await postCost("Edited memo"); // same key, changed memo
    expect(changed.status).toBe(302);
    // Rejected with an error flash, not a false success.
    expect(parseFlashCookie(changed).success).toBeUndefined();
    // Still exactly one cost, and the stored memo is the original — the edit was
    // rejected, not silently swallowed.
    const { getServicingCosts } = await import(
      "#shared/db/attendees/servicing.ts"
    );
    const costs = await getServicingCosts(id);
    expect(costs).toHaveLength(1);
    expect(costs[0]!.memo).toBe("Original memo");
  });

  test("recordServiceCost throws COST_REPLAY_MISMATCH when a stored reference's payload changed", async () => {
    // The data-layer guard behind the route form-error: same reference, changed
    // amount → a loud throw, never a stale-leg replay.
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
    // Nothing new landed.
    expect((await transfersOfKind(KIND.serviceCost)).length).toBe(1);
    expect(await listingCostOf(listing.id)).toBe(9000);
  });

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
    const response = await adminPost(`/admin/servicing/${id}/cost/${costId}`, {
      amount: "60.00",
    });
    expect(response.headers.get("location")).toContain(
      `/admin/servicing/${id}`,
    );
    expect(await listingCostOf(listing.id)).toBe(6000);
  });

  test("invalid create cost amounts write no service_cost transfer (form error, not 500)", async () => {
    // Empty, negative, non-numeric, and zero amounts must be rejected at the
    // route as a form-error redirect, never reach the ledger, and never 500.
    const { id, listing } = await createServicingHold();
    const before = (await transfersOfKind(KIND.serviceCost)).length;
    for (const amount of ["", "-5", "abc", "0"]) {
      const response = await adminPost(`/admin/servicing/${id}`, {
        amount,
        memo: "Bad",
        target_listing_id: String(listing.id),
      });
      await expectCostFormError(response, id, before);
    }
    expect(await listingCostOf(listing.id)).toBe(0);
  });

  test("an invalid create target_listing_id writes no service_cost transfer", async () => {
    const { id, listing } = await createServicingHold();
    const before = (await transfersOfKind(KIND.serviceCost)).length;
    for (const target of ["", "abc", "0", "-3"]) {
      const response = await adminPost(`/admin/servicing/${id}`, {
        amount: "90.00",
        memo: "Bad",
        target_listing_id: target,
      });
      expect(response.status).toBe(302);
      expect((await transfersOfKind(KIND.serviceCost)).length).toBe(before);
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
    expect((await transfersOfKind(KIND.serviceCost)).length).toBe(before);
    expect(await listingCostOf(listing.id)).toBe(0);
  });

  test("invalid edit cost amounts write no service_cost transfer (form error, not 500)", async () => {
    const { id, listing } = await createServicingHold();
    const costId = await recordBoilerCost(id, listing.id);
    const before = (await transfersOfKind(KIND.serviceCost)).length;
    for (const amount of ["", "-5", "abc", "0"]) {
      const response = await adminPost(
        `/admin/servicing/${id}/cost/${costId}`,
        { amount },
      );
      await expectCostFormError(response, id, before);
    }
    // The original £90 cost is untouched — no delta leg landed.
    expect(await listingCostOf(listing.id)).toBe(9000);
  });

  test("deleting a servicing event leaves its cost legs as append-only history", async () => {
    // The transfers ledger is append-only — deleting a servicing event does
    // NOT reverse or remove its cost legs. They remain as history, the same
    // way sale legs for a deleted listing remain. The ledger UI shows
    // "Deleted listing" for the unresolved account label.
    const { id, listing } = await createServicingHold();
    await recordBoilerCost(id, listing.id);
    expect(await listingCostOf(listing.id)).toBe(9000);
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
    expect(body).toContain("Service event costs");
    expect(body).toContain(formatCurrency(9000));
    expect(body).toContain("Boiler part");
    expect(body).toContain(listing.name);
    expect(body).toContain("Money out");
    expect(body).toContain(`href="/admin/ledger?listing=${listing.id}"`);
    expect(body).toContain("View money history");
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
    // Ordering contract: the reader must return records in the SQL
    // ORDER BY occurred_at, transfer_id — not the order its concurrent decrypt()
    // calls happen to resolve in. Building the result as a pure
    // Promise.all(records.map(...)) preserves the query order by construction;
    // the earlier push()-into-shared-array form leaned on crypto-op scheduling.
    // Dates are scrambled vs insertion order, so a reader that skips the re-sort
    // (or drifts a decrypted memo onto the wrong record) fails here.
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
    expect(costs.map((c) => c.date.slice(0, 10))).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-04",
    ]);
    // Each record keeps its own memo — proving a row wasn't re-sorted by date
    // while its decrypted memo drifted onto a different record.
    expect(costs.map((c) => c.memo)).toEqual([
      "memo-2026-07-01",
      "memo-2026-07-02",
      "memo-2026-07-03",
      "memo-2026-07-04",
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
    for (const r of rows) {
      expect(r.memo ?? "").not.toContain("07700 900000");
    }
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

  test("service_cost legs appear in the listing-filtered visible ledger", async () => {
    // Verifies that revenueLegScope includes cost-account legs so operators can
    // see service costs when they filter the ledger by listing.
    const { id, listing } = await createServicingHold();
    await recordBoilerCost(id, listing.id); // £90
    const legs = await visibleTransfers(emptyRange, [listing.id], 100);
    expect(legs.some((t) => t.kind === KIND.serviceCost)).toBe(true);
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
});
