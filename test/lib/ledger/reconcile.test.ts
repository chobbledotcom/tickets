import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { account } from "#shared/ledger/account.ts";
import {
  type LegFingerprint,
  legFingerprint,
  reconcileExternal,
  reconcileLegs,
} from "#shared/ledger/reconcile.ts";
import type { Transfer } from "#shared/ledger/types.ts";
import { makeTransfer } from "./factory.ts";

const psp = account("psp", "stripe");
const world = account("external", "world");

describe("reconcileExternal", () => {
  it("is ok with a zero diff when the balance matches the report", () => {
    const ts = [
      makeTransfer({ amount: 5000, destination: psp, source: world }),
    ];
    expect(reconcileExternal(psp, 5000)(ts)).toEqual({
      actual: 5000,
      diff: 0,
      expected: 5000,
      ok: true,
    });
  });

  it("reports the signed drift when they differ", () => {
    const ts = [
      makeTransfer({ amount: 5000, destination: psp, source: world }),
    ];
    expect(reconcileExternal(psp, 4925)(ts)).toEqual({
      actual: 5000,
      diff: 75,
      expected: 4925,
      ok: false,
    });
  });
});

describe("reconcileLegs", () => {
  const attendee = account("attendee", 1);
  const revenueA = account("revenue", 1);
  const revenueB = account("revenue", 2);

  const saleA = makeTransfer({
    amount: 5000,
    destination: revenueA,
    eventGroup: "evt-a",
    id: 1,
    kind: "sale",
    source: attendee,
  });
  const payA = makeTransfer({
    amount: 5000,
    destination: attendee,
    eventGroup: "evt-a",
    id: 2,
    kind: "payment",
    source: world,
  });

  /** Build the expected-fingerprint map the same way the ledger derives it. */
  const expectedFor = (...legs: Transfer[]): Map<string, LegFingerprint[]> => {
    const map = new Map<string, LegFingerprint[]>();
    for (const leg of legs) {
      const fps = map.get(leg.eventGroup) ?? [];
      fps.push(legFingerprint(leg));
      map.set(leg.eventGroup, fps);
    }
    return map;
  };

  it("returns nothing when observed legs match, regardless of order", () => {
    expect(reconcileLegs(expectedFor(saleA, payA))([payA, saleA])).toEqual([]);
  });

  it("flags a leg posted to the wrong account even when its kind matches", () => {
    // Expected a sale to revenue:1; the ledger booked a same-kind, same-amount
    // sale to revenue:2 — a bare-kind compare would miss this corruption.
    const wrongAccount = makeTransfer({
      amount: 5000,
      destination: revenueB,
      eventGroup: "evt-a",
      id: 1,
      kind: "sale",
      source: attendee,
    });
    expect(
      reconcileLegs(expectedFor(saleA, payA))([wrongAccount, payA]),
    ).toEqual([
      {
        eventGroup: "evt-a",
        missing: [legFingerprint(saleA)],
        unexpected: [legFingerprint(wrongAccount)],
      },
    ]);
  });

  it("flags a leg with the wrong amount even when kind and accounts match", () => {
    const wrongAmount = makeTransfer({
      amount: 9999,
      destination: revenueA,
      eventGroup: "evt-a",
      id: 1,
      kind: "sale",
      source: attendee,
    });
    expect(
      reconcileLegs(expectedFor(saleA, payA))([wrongAmount, payA]),
    ).toEqual([
      {
        eventGroup: "evt-a",
        missing: [legFingerprint(saleA)],
        unexpected: [legFingerprint(wrongAmount)],
      },
    ]);
  });

  it("flags an entirely missing event group", () => {
    expect(reconcileLegs(expectedFor(saleA, payA))([])).toEqual([
      {
        eventGroup: "evt-a",
        missing: [legFingerprint(saleA), legFingerprint(payA)],
        unexpected: [],
      },
    ]);
  });

  it("flags an orphan event group absent from the source records", () => {
    expect(reconcileLegs(new Map())([saleA])).toEqual([
      {
        eventGroup: "evt-a",
        missing: [],
        unexpected: [legFingerprint(saleA)],
      },
    ]);
  });

  it("treats a leg with no kind as an empty-string kind", () => {
    const withEmptyKind = makeTransfer({
      eventGroup: "evt-c",
      id: 1,
      kind: "",
    });
    const observedNoKind = makeTransfer({ eventGroup: "evt-c", id: 1 });
    expect(reconcileLegs(expectedFor(withEmptyKind))([observedNoKind])).toEqual(
      [],
    );
  });
});
