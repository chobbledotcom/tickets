import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  accountBalance,
  accountBalancesForIds,
  accountBalancesOfType,
  transfersByAccount,
  transfersByEventGroup,
} from "#shared/accounting/queries.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { account } from "#shared/ledger/account.ts";
import { balanceOf } from "#shared/ledger/project.ts";
import { tx, useTransactionalDb } from "#test-utils/ledger.ts";

const world = account("external", "world");

describe("db > accounting > queries", () => {
  useTransactionalDb();

  describe("balance queries", () => {
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
      expect(income.get("1")).toBe(1000);
      expect(income.get("2")).toBe(3000);
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
  });

  describe("reads", () => {
    test("transfersByEventGroup returns only that event's legs", async () => {
      await postTransfers([
        tx({ eventGroup: "evt-x", reference: "x-sale" }),
        tx({
          destination: account("attendee", 1),
          eventGroup: "evt-x",
          reference: "x-pay",
          source: world,
        }),
      ]);
      await postTransfers([tx({ eventGroup: "evt-y", reference: "y-sale" })]);
      const legs = await transfersByEventGroup("evt-x");
      expect(legs.map((t) => t.reference).toSorted()).toEqual([
        "x-pay",
        "x-sale",
      ]);
    });
  });
});
