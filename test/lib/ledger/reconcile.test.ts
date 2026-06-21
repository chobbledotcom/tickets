import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { account } from "#shared/ledger/account.ts";
import {
  reconcileExternal,
  reconcileLegCounts,
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

describe("reconcileLegCounts", () => {
  const legs = (eventGroup: string, n: number) =>
    Array.from({ length: n }, (_, i) =>
      makeTransfer({ eventGroup, id: i + 1 }),
    );

  it("returns nothing when every event matches its expected count", () => {
    const expected = new Map([
      ["evt-a", 3],
      ["evt-b", 1],
    ]);
    const ts = [...legs("evt-a", 3), ...legs("evt-b", 1)];
    expect(reconcileLegCounts(expected)(ts)).toEqual([]);
  });

  it("flags an event that is missing a leg", () => {
    const expected = new Map([["evt-a", 3]]);
    expect(reconcileLegCounts(expected)(legs("evt-a", 2))).toEqual([
      { actual: 2, eventGroup: "evt-a", expected: 3 },
    ]);
  });

  it("flags an entirely missing event group", () => {
    const expected = new Map([["evt-a", 3]]);
    expect(reconcileLegCounts(expected)([])).toEqual([
      { actual: 0, eventGroup: "evt-a", expected: 3 },
    ]);
  });

  it("flags an orphan event group absent from the source records", () => {
    const expected = new Map<string, number>();
    expect(reconcileLegCounts(expected)(legs("evt-x", 2))).toEqual([
      { actual: 2, eventGroup: "evt-x", expected: 0 },
    ]);
  });
});
