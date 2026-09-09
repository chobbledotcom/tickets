import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { account, accountKey } from "#shared/ledger/account.ts";
import {
  allBalances,
  balanceOf,
  statementFor,
} from "#shared/ledger/project.ts";
import { makeTransfer } from "#test-utils/transfer-factory.ts";

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

  it("is zero for an account with no transfers in the slice", () => {
    const ts = [makeTransfer({ destination: revenue, source: attendee })];
    expect(balanceOf(account("modifier", 99))(ts)).toBe(0);
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

  it("ends its running balance exactly at balanceOf, whatever the input order", () => {
    // The statement and the balance must be the same fold: if the last running
    // figure ever drifted from balanceOf, the two surfaces would disagree on
    // what the account holds.
    const ts = [
      makeTransfer({
        amount: 10000,
        destination: revenue,
        id: 1,
        source: attendee,
      }),
      makeTransfer({
        amount: 4000,
        destination: attendee,
        id: 2,
        occurredAt: "2026-02-01T00:00:00.000Z",
        source: world,
      }),
      makeTransfer({
        amount: 200,
        destination: fee,
        id: 3,
        occurredAt: "2026-03-01T00:00:00.000Z",
        source: attendee,
      }),
    ];
    const permutations = [ts, [...ts].reverse(), [ts[1]!, ts[2]!, ts[0]!]];
    for (const permuted of permutations) {
      const lines = statementFor(attendee)(permuted);
      expect(lines.at(-1)?.running).toBe(balanceOf(attendee)(permuted));
    }
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
