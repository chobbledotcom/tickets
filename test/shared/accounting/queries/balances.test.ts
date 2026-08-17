// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  accountBalance,
  accountBalancesForIds,
  accountBalancesOfType,
  transfersByAccount,
  transfersByAccounts,
} from "#shared/accounting/queries.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { account, accountKey } from "#shared/ledger/account.ts";
import { balanceOf } from "#shared/ledger/project.ts";
import { tx, useTransactionalDb } from "#test-utils/ledger.ts";

// jscpd:ignore-end

const world = account("external", "world");

describe("db > accounting > balance queries", () => {
  useTransactionalDb();

  test("accountBalance nets credits minus debits, zero when untouched", async () => {
    const attendee = account("attendee", 9);
    const revenue = account("revenue", 9);
    await postTransfers([
      tx({ destination: revenue, reference: "sale", source: attendee }),
      tx({
        amount: 2000,
        destination: attendee,
        reference: "pay",
        source: world,
      }),
    ]);
    expect(await accountBalance(revenue)).toBe(5000);
    expect(await accountBalance(attendee)).toBe(-3000); // still owes 3000
    expect(await accountBalance(account("revenue", 404))).toBe(0);
  });

  test("accountBalancesOfType returns every account of a type at once", async () => {
    await postTransfers([
      tx({
        amount: 1000,
        destination: account("revenue", 1),
        eventGroup: "e1",
        reference: "r1",
        source: account("attendee", 1),
      }),
    ]);
    await postTransfers([
      tx({
        amount: 3000,
        destination: account("revenue", 2),
        eventGroup: "e2",
        reference: "r2",
        source: account("attendee", 2),
      }),
    ]);
    const income = await accountBalancesOfType("revenue");
    expect(income).toEqual(
      new Map([
        ["1", 1000],
        ["2", 3000],
      ]),
    );
  });

  test("accountBalancesForIds scopes to given ids; empty is a no-op", async () => {
    await postTransfers([
      tx({
        amount: 1000,
        destination: account("revenue", 1),
        reference: "r1",
        source: account("attendee", 1),
      }),
      tx({
        amount: 3000,
        destination: account("revenue", 2),
        reference: "r2",
        source: account("attendee", 2),
      }),
    ]);
    const scoped = await accountBalancesForIds("revenue", ["1"]);
    expect(scoped.get("1")).toBe(1000);
    expect(scoped.has("2")).toBe(false);
    expect((await accountBalancesForIds("revenue", [])).size).toBe(0);
  });

  test("SQL balance agrees with the in-memory projection", async () => {
    const attendee = account("attendee", 5);
    const revenue = account("revenue", 5);
    await postTransfers([
      tx({ destination: revenue, reference: "s", source: attendee }),
      tx({
        amount: 2000,
        destination: attendee,
        reference: "p",
        source: world,
      }),
    ]);
    for (const acct of [attendee, revenue]) {
      const slice = await transfersByAccount(acct);
      expect(await accountBalance(acct)).toBe(balanceOf(acct)(slice));
    }
  });

  test("reads several account types once and returns empty requested accounts", async () => {
    const attendee = account("attendee", 6);
    const revenue = account("revenue", 6);
    const untouched = account("attendee", 404);
    await postTransfers([
      tx({ destination: revenue, reference: "multi-sale", source: attendee }),
      tx({
        amount: 2000,
        destination: attendee,
        reference: "multi-pay",
        source: world,
      }),
    ]);

    const transfers = await transfersByAccounts([
      attendee,
      attendee,
      revenue,
      untouched,
    ]);

    expect(transfers.get(accountKey(attendee))).toHaveLength(2);
    expect(transfers.get(accountKey(revenue))).toHaveLength(1);
    expect(transfers.get(accountKey(untouched))).toEqual([]);
    expect(await transfersByAccounts([])).toEqual(new Map());
  });
});
