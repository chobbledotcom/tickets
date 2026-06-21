import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { account } from "#shared/ledger/account.ts";
import {
  reconcileExternal,
  reconcileLegKinds,
} from "#shared/ledger/reconcile.ts";
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

describe("reconcileLegKinds", () => {
  const legs = (eventGroup: string, kinds: string[]) =>
    kinds.map((kind, i) => makeTransfer({ eventGroup, id: i + 1, kind }));

  it("returns nothing when every event has its expected kinds", () => {
    const expected = new Map([
      ["evt-a", ["sale", "fee", "payment"]],
      ["evt-b", ["sale"]],
    ]);
    const ts = [
      ...legs("evt-a", ["payment", "sale", "fee"]),
      ...legs("evt-b", ["sale"]),
    ];
    expect(reconcileLegKinds(expected)(ts)).toEqual([]);
  });

  it("flags a wrong leg mix even when the leg count matches", () => {
    const expected = new Map([["evt-a", ["sale", "fee", "payment"]]]);
    const ts = legs("evt-a", ["sale", "sale", "payment"]);
    expect(reconcileLegKinds(expected)(ts)).toEqual([
      { eventGroup: "evt-a", missing: ["fee"], unexpected: ["sale"] },
    ]);
  });

  it("flags an entirely missing event group", () => {
    const expected = new Map([["evt-a", ["sale", "payment"]]]);
    expect(reconcileLegKinds(expected)([])).toEqual([
      { eventGroup: "evt-a", missing: ["sale", "payment"], unexpected: [] },
    ]);
  });

  it("flags an orphan event group absent from the source records", () => {
    const expected = new Map<string, string[]>();
    const ts = legs("evt-x", ["sale", "payment"]);
    expect(reconcileLegKinds(expected)(ts)).toEqual([
      { eventGroup: "evt-x", missing: [], unexpected: ["sale", "payment"] },
    ]);
  });

  it("treats a leg with no kind as an empty-string kind", () => {
    const expected = new Map([["evt-a", [""]]]);
    const ts = [makeTransfer({ eventGroup: "evt-a" })];
    expect(reconcileLegKinds(expected)(ts)).toEqual([]);
  });
});
