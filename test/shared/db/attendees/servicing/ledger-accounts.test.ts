// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { costAccount } from "#accounting/accounts.ts";
import { account } from "#shared/ledger/account.ts";

// jscpd:ignore-end

describe("servicing §22 - cost account", () => {
  test("costAccount rejects 0/negative/fractional ids (no phantom cost account)", () => {
    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => costAccount(bad)).toThrow();
    }
  });

  test("costAccount mints a cost:<id> account for a positive integer id", () => {
    expect(costAccount(5)).toEqual(account("cost", 5));
  });
});
