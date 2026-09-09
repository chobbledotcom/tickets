import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { account } from "#shared/ledger/account.ts";
import { isInverseOf } from "#shared/ledger/reverse.ts";
import { makeTransfer } from "#test-utils/transfer-factory.ts";

describe("isInverseOf", () => {
  const original = makeTransfer({
    amount: 5000,
    destination: account("revenue", 45),
    id: 7,
    source: account("attendee", 88),
  });
  // The leg a reversal posts: the original's ends swapped, same amount.
  const reversal = {
    amount: 5000,
    destination: account("attendee", 88),
    source: account("revenue", 45),
  };

  it("accepts the leg that exactly undoes the original", () => {
    expect(isInverseOf(reversal, original)).toBe(true);
  });

  it("rejects a different amount or direction", () => {
    expect(isInverseOf({ ...reversal, amount: 4000 }, original)).toBe(false);
    // Same direction as the original (ends not swapped).
    expect(isInverseOf(original, original)).toBe(false);
  });
});
