import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { account, accountKey } from "#shared/ledger/account.ts";
import {
  allBalances,
  assertSingleCurrency,
  balanceOf,
  currenciesIn,
  inPeriod,
  statementFor,
  sumOfKind,
} from "#shared/ledger/project.ts";
import { makeTransfer } from "./factory.ts";

const world = account("external", "world");
const attendee = account("attendee", 88);
const revenue = account("revenue", 45);
const fee = account("fee_income", "booking");

describe("balanceOf", () => {
  it("nets money in (destination) minus money out (source)", () => {
    const ts = [
      makeTransfer({ amount: 5000, destination: revenue, source: attendee }),
      makeTransfer({ amount: 5000, destination: attendee, source: world }),
    ];
    expect(balanceOf(attendee)(ts)).toBe(0);
    expect(balanceOf(revenue)(ts)).toBe(5000);
    expect(balanceOf(world)(ts)).toBe(-5000);
  });

  it("leaves a deposit attendee owing the remainder", () => {
    const ts = [
      makeTransfer({ amount: 10000, destination: revenue, source: attendee }),
      makeTransfer({ amount: 2000, destination: attendee, source: world }),
    ];
    expect(balanceOf(attendee)(ts)).toBe(-8000);
  });
});

describe("allBalances", () => {
  it("conserves: every account balance sums to zero", () => {
    const ts = [
      makeTransfer({ amount: 5000, destination: revenue, source: attendee }),
      makeTransfer({ amount: 200, destination: fee, source: attendee }),
      makeTransfer({ amount: 5200, destination: attendee, source: world }),
    ];
    const balances = allBalances(ts);
    const total = [...balances.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(0);
    expect(balances.get(accountKey(revenue))).toBe(5000);
    expect(balances.get(accountKey(fee))).toBe(200);
    expect(balances.get(accountKey(world))).toBe(-5200);
  });

  it("is independent of input order", () => {
    const a = makeTransfer({ amount: 100, destination: revenue, id: 1 });
    const b = makeTransfer({ amount: 30, destination: attendee, id: 2 });
    expect(allBalances([a, b])).toEqual(allBalances([b, a]));
  });
});

describe("sumOfKind", () => {
  it("counts only the named kind (a refund is its cash leg, not doubled)", () => {
    const ts = [
      makeTransfer({ amount: 2000, kind: "refund_reversal" }),
      makeTransfer({ amount: 2000, kind: "refund_cash" }),
    ];
    expect(sumOfKind("refund_cash")(ts)).toBe(2000);
  });
});

describe("inPeriod", () => {
  it("includes the start and excludes the end (half-open window)", () => {
    const ts = [
      makeTransfer({ id: 1, occurredAt: "2026-01-01T00:00:00.000Z" }),
      makeTransfer({ id: 2, occurredAt: "2026-02-01T00:00:00.000Z" }),
      makeTransfer({ id: 3, occurredAt: "2026-03-01T00:00:00.000Z" }),
    ];
    const got = inPeriod(
      "2026-02-01T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
    )(ts);
    expect(got.map((t) => t.id)).toEqual([2]);
  });

  it("includes a canonical .000Z transfer at a whole-second bound", () => {
    const ts = [
      makeTransfer({ id: 1, occurredAt: "2026-02-01T00:00:00.000Z" }),
    ];
    // Whole-second bounds (no milliseconds): a lexicographic compare would
    // exclude the canonical .000Z value; instant comparison includes it.
    const got = inPeriod("2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z")(ts);
    expect(got.map((t) => t.id)).toEqual([1]);
  });

  it("throws on a non-ISO period bound", () => {
    expect(() => inPeriod("nonsense", "2026-03-01T00:00:00.000Z")([])).toThrow(
      "invalid bound",
    );
  });

  it("throws on an unparseable (month 13) bound", () => {
    expect(() =>
      inPeriod("2026-01-01T00:00:00.000Z", "2026-13-01T00:00:00Z")([]),
    ).toThrow("invalid bound");
  });

  it("throws on an overflow date bound (Feb 30 normalises away)", () => {
    expect(() =>
      inPeriod("2026-02-30T00:00:00Z", "2026-03-01T00:00:00.000Z")([]),
    ).toThrow("invalid bound");
  });

  it("throws on an inverted window (from after to)", () => {
    // A swapped range would otherwise silently match nothing, reading as zero
    // revenue/refunds instead of a bad request.
    expect(() =>
      inPeriod("2026-03-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z")([]),
    ).toThrow("inverted window");
  });

  it("allows an empty window where from equals to", () => {
    const bound = "2026-02-01T00:00:00.000Z";
    const ts = [makeTransfer({ occurredAt: bound })];
    expect(inPeriod(bound, bound)(ts)).toEqual([]);
  });
});

describe("statementFor", () => {
  it("orders by business time then id with a correct running balance", () => {
    const later = makeTransfer({
      amount: 8000,
      destination: attendee,
      id: 5,
      occurredAt: "2026-03-01T00:00:00.000Z",
      source: world,
    });
    const earlier = makeTransfer({
      amount: 2000,
      destination: attendee,
      id: 9,
      occurredAt: "2026-01-01T00:00:00.000Z",
      source: world,
    });
    const sale = makeTransfer({
      amount: 10000,
      destination: revenue,
      id: 1,
      occurredAt: "2026-01-01T00:00:00.000Z",
      source: attendee,
    });
    const lines = statementFor(attendee)([later, earlier, sale]);
    expect(lines.map((l) => l.transfer.id)).toEqual([1, 9, 5]);
    expect(lines.map((l) => l.running)).toEqual([-10000, -8000, 0]);
  });

  it("continues from an opening balance for a date-ranged slice", () => {
    const debit = makeTransfer({
      amount: 2000,
      destination: revenue,
      id: 1,
      source: attendee,
    });
    const lines = statementFor(attendee, 8000)([debit]);
    expect(lines.map((l) => l.running)).toEqual([6000]);
  });
});

describe("currency guards", () => {
  it("lists distinct currencies in first-seen order", () => {
    const ts = [
      makeTransfer({ currency: "GBP" }),
      makeTransfer({ currency: "USD" }),
      makeTransfer({ currency: "GBP" }),
    ];
    expect(currenciesIn(ts)).toEqual(["GBP", "USD"]);
  });

  it("tolerates a single currency or an empty slice", () => {
    expect(() => assertSingleCurrency([])).not.toThrow();
    expect(() => assertSingleCurrency([makeTransfer({})])).not.toThrow();
  });

  it("throws when a projection is asked to sum across currencies", () => {
    const ts = [
      makeTransfer({ currency: "GBP" }),
      makeTransfer({ currency: "USD" }),
    ];
    expect(() => balanceOf(attendee)(ts)).toThrow("mixed-currency");
  });
});
