// test-groups: run-alone
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  type RenewalFacts,
  renderRenewals,
} from "#scripts/verify-models/subscriptions/renewal-facts.ts";
import { captureRead } from "#scripts/verify-models/subscriptions/renewal-observations.ts";
import { renewalFacts } from "#scripts/verify-models/subscriptions/renewals.ts";
import { requireValue } from "#shared/required-value.ts";
import { records } from "#test-utils/tla-data.ts";

const snapshot = (
  facts: Awaited<ReturnType<typeof renewalFacts>>,
  attempt: string,
  when = "after",
) =>
  requireValue(
    facts.snapshots.find((row) => row.attempt === attempt && row.when === when),
    `Missing renewal snapshot ${attempt} ${when}`,
  );

/** The cash, sale, and VAT amounts of one attempt's legs after its call. */
const legAmounts = (
  facts: Awaited<ReturnType<typeof renewalFacts>>,
  attempt: string,
) => {
  const legs = snapshot(facts, attempt);
  return [legs.cashAmount, legs.saleAmount, legs.vatAmount];
};

test("renewal facts preserve observed cash, independently rounded VAT, and account attribution", async () => {
  const facts = await renewalFacts();
  expect(snapshot(facts, "normal:0")).toMatchObject({
    cashAmount: 600,
    cashCount: 1,
    cashDestination: "attendee:1",
    cashSource: "external:world",
    saleAmount: 500,
    saleCount: 1,
    saleDestination: "revenue:1",
    saleSource: "attendee:1",
    vatAmount: 100,
    vatCount: 1,
    vatDestination: "tax:vat",
    vatSource: "attendee:1",
  });
  expect(snapshot(facts, "partial:0")).toMatchObject({
    cashAmount: 303,
    saleAmount: 252,
    vatAmount: 51,
  });
  expect(snapshot(facts, "tax_only:0")).toMatchObject({
    cashAmount: 1,
    saleCount: 0,
    vatAmount: 1,
  });
  const first = requireValue(
    facts.operations.find((fact) => fact.attempt === "normal:0"),
    "Missing first renewal attempt",
  );
  expect(
    facts.reads.filter(
      (fact) => fact.kind === "renewal" && fact.owner === "normal:0",
    ),
  ).toEqual([
    {
      kind: "renewal",
      ordinal: 0,
      owner: "normal:0",
      target: first.snapshotSubscription,
    },
  ]);
  expect(facts.reads.filter((fact) => fact.kind === "currency")).toEqual(
    ["site_currency", "foreign_currency", "mixed_currency"].map((owner) => ({
      kind: "currency",
      ordinal: 0,
      owner,
      target: "sub_currency",
    })),
  );
});

test("renewal facts observe exact replay and loud conflicting replay", async () => {
  const facts = await renewalFacts();
  const before = snapshot(facts, "normal:1", "before");
  const after = snapshot(facts, "normal:1");
  expect(after).toEqual({ ...before, when: "after" });
  expect(
    facts.operations
      .filter((row) => row.scenario === "conflict")
      .map((row) => ({
        after: row.afterStatus,
        before: row.beforeStatus,
        outcome: row.outcome,
      })),
  ).toEqual([
    { after: "active", before: "trialing", outcome: "returned" },
    { after: "active", before: "active", outcome: "ledger_conflict" },
  ]);
});

test("renewal facts observe all identity fences and preserve ended statuses with eligible money", async () => {
  const facts = await renewalFacts();
  expect(
    facts.operations
      .filter((row) => row.scenario.startsWith("identity_"))
      .map((row) => [row.scenario, row.outcome]),
  ).toEqual([
    ["identity_id", "booking_fence"],
    ["identity_attendee", "booking_fence"],
    ["identity_listing", "booking_fence"],
    ["identity_subscription", "booking_fence"],
  ]);
  expect(
    requireValue(
      facts.operations.find((row) => row.scenario === "stale_status"),
      "Missing stale-status observation",
    ),
  ).toMatchObject({
    afterStatus: "canceled",
    beforeStatus: "canceled",
    outcome: "returned",
  });
  expect(snapshot(facts, "stale_status:0")).toMatchObject({
    cashAmount: 600,
    cashCount: 1,
  });
});

test("renewal faults roll back a prior status and cash write before a successful retry", async () => {
  const facts = await renewalFacts();
  expect(
    facts.operations
      .filter((row) => row.scenario === "rollback")
      .map((row) => ({
        after: row.afterStatus,
        outcome: row.outcome,
      })),
  ).toEqual([
    { after: "trialing", outcome: "write_fault" },
    { after: "canceled", outcome: "returned" },
  ]);
  expect(snapshot(facts, "rollback:0")).toMatchObject({
    cashAmount: 0,
    cashCount: 0,
    saleCount: 0,
    vatCount: 0,
  });
  expect(legAmounts(facts, "rollback:1")).toEqual([600, 500, 100]);
});

test("renewal evidence preserves invoice identity at the full provider list limit", async () => {
  const facts = await renewalFacts();
  const after = facts.snapshots.filter(
    (row) => row.attempt === "hundred:0" && row.when === "after",
  );
  expect(
    after.map((row) => [
      row.cashCount,
      row.cashAmount,
      row.saleAmount,
      row.vatAmount,
    ]),
  ).toEqual(Array.from({ length: 100 }, () => [1, 600, 500, 100]));
  for (const identity of ["invoice", "cashReference"] as const)
    expect(new Set(after.map((row) => row[identity])).size).toBe(100);
});

test("the exact arithmetic domain includes a real floating-point half-unit regression", async () => {
  const facts = await renewalFacts();
  expect(facts.arithmetic).toContainEqual({
    amount: 200_000_004,
    caseId: "below_half",
    observedTax: 100_000_001,
    price: 200_000_003,
    tax: 100_000_001,
  });
});

test("a stored VAT defect reaches renewal facts through the real database boundary", async () => {
  const facts = await renewalFacts("stored_vat");
  expect(legAmounts(facts, "normal:0")).toEqual([600, 500, 101]);
});

test("one stored plan survives listing edits, renewals, and owner cancellation", async () => {
  const facts = await renewalFacts();
  const first = requireValue(
    facts.journeys.find((fact) => fact.phase === "stored"),
    "Missing joined stored plan",
  );
  const plan = {
    attendee: 50000,
    booking: first.booking,
    checkoutAt: Date.parse("2024-01-31T10:15:00Z") / 1000,
    expectedTrialAt: Date.parse("2024-02-29T10:15:00Z") / 1000,
    interval: "month",
    listing: 171,
    observedAmount: 1202,
    observedSubscription: "sub_model_17",
    price: 1202,
    projectionCount: 1,
    quantity: 2,
    requestedAmount: 1202,
    requestedSubscription: "sub_model_17",
    subscription: "sub_model_17",
    tax: 200,
    trialAt: Date.parse("2024-02-29T10:15:00Z") / 1000,
  };
  expect(facts.journeys).toEqual(
    ["stored", "edited", "renewed", "cancelled"].map((phase) =>
      expect.objectContaining({
        ...plan,
        cancelReturned: phase === "cancelled",
        phase,
        status: phase === "cancelled" ? "canceled" : "active",
      }),
    ),
  );
  expect(
    facts.invoices
      .filter((fact) => fact.attempt === "joined:1")
      .map(
        ({ amount, attendee, expectedAt, invoice, listing, price, tax }) => ({
          amount,
          attendee,
          expectedAt,
          invoice,
          listing,
          price,
          tax,
        }),
      ),
  ).toEqual([
    {
      amount: 1202,
      attendee: "attendee:50000",
      expectedAt: Date.parse("2024-02-29T10:15:00Z") / 1000,
      invoice: "in_joined_a",
      listing: "revenue:171",
      price: 1202,
      tax: 200,
    },
    {
      amount: 303,
      attendee: "attendee:50000",
      expectedAt: Date.parse("2024-03-29T10:15:00Z") / 1000,
      invoice: "in_joined_last",
      listing: "revenue:171",
      price: 1202,
      tax: 200,
    },
  ]);
});

test("failed checkout retries keep the observed subscription and charge on one retained booking", async () => {
  const { failedJoins } = await renewalFacts();
  const first = requireValue(failedJoins[0], "Missing failed checkout join");
  expect(failedJoins).toEqual(
    [
      {
        attempt: 1,
        authorityReturned: 0,
        confirmed: false,
        held: 1,
        refundCash: 0,
        refunds: 0,
      },
      {
        attempt: 2,
        authorityReturned: 600,
        confirmed: true,
        held: 0,
        refundCash: 600,
        refunds: 1,
      },
      {
        attempt: 3,
        authorityReturned: 600,
        confirmed: true,
        held: 0,
        refundCash: 600,
        refunds: 1,
      },
    ].map((attempt) =>
      expect.objectContaining({
        ...attempt,
        amount: 600,
        attendee: first.attendee,
        booking: first.booking,
        consumedReference: "pi_failed",
        interval: "month",
        listing: 1,
        observedAmount: 600,
        observedReference: "pi_failed",
        observedSubscription: "sub_failed",
        quantity: 0,
        refundBeforeEnd: 0,
        subscription: "sub_failed",
        tax: 0,
      }),
    ),
  );
});

test("provider-read evidence retains wrong and repeated targets before a later correct read", async () => {
  const reads: RenewalFacts["reads"] = [];
  const observe = captureRead(reads, "renewal", "attempt", () =>
    Promise.resolve([]),
  );
  await observe("sub_other");
  await observe("sub_correct");
  await observe("sub_correct");
  expect(reads).toEqual([
    { kind: "renewal", ordinal: 0, owner: "attempt", target: "sub_other" },
    { kind: "renewal", ordinal: 1, owner: "attempt", target: "sub_correct" },
    { kind: "renewal", ordinal: 2, owner: "attempt", target: "sub_correct" },
  ]);
});

test("an invoice without both ledger snapshots cannot reach the checker", async () => {
  const facts = await renewalFacts();
  const [first, ...rest] = facts.snapshots;
  const lost = requireValue(first, "Missing renewal snapshot");
  expect(() => renderRenewals({ ...facts, snapshots: rest })).toThrow(
    "A ledger snapshot has no invoice fact.",
  );
  expect(() =>
    renderRenewals({
      ...facts,
      snapshots: [{ ...lost, when: "after" }, ...rest],
    }),
  ).toThrow(
    `The invoice ${lost.invoice} of ${lost.attempt} has 0 ledger snapshots before the call.`,
  );
});

test("each rendered invoice carries its legs before and after the call", async () => {
  const facts = await renewalFacts();
  const rows = records(renderRenewals(facts), "InvoiceFacts").filter(
    (row) => row.attempt === "normal:1",
  );
  expect(rows).toEqual([
    expect.objectContaining({
      afterCashAmount: 600,
      afterCashCount: 1,
      beforeCashAmount: 600,
      beforeCashCount: 1,
      invoice: "in_normal_a",
    }),
  ]);
  expect(Object.keys(requireValue(rows[0], "Missing joined invoice"))).toEqual(
    expect.not.arrayContaining(["when", "afterAttempt", "beforeScenario"]),
  );
});
