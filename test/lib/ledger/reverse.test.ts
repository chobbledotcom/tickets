import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { account } from "#shared/ledger/account.ts";
import { balanceOf } from "#shared/ledger/project.ts";
import { isInverseOf, reverseOf } from "#shared/ledger/reverse.ts";
import { makeTransfer } from "./factory.ts";

const meta = {
  eventGroup: "void-1",
  occurredAt: "2026-04-01T00:00:00.000Z",
  postedBy: "user:3",
  reference: "void-ref",
};

describe("reverseOf", () => {
  it("swaps the ends, keeps the amount, and links via reversesId", () => {
    const original = makeTransfer({
      amount: 5000,
      destination: account("revenue", 45),
      id: 7,
      source: account("attendee", 88),
    });
    const rev = reverseOf(original, meta);
    expect(rev.source).toEqual(original.destination);
    expect(rev.destination).toEqual(original.source);
    expect(rev.amount).toBe(5000);
    expect(rev.reversesId).toBe(7);
    expect(rev.kind).toBe("reversal");
    expect(rev.memo).toBe("");
  });

  it("honours an explicit kind and memo", () => {
    const rev = reverseOf(makeTransfer({}), {
      ...meta,
      kind: "correction",
      memo: "fat-finger",
    });
    expect(rev.kind).toBe("correction");
    expect(rev.memo).toBe("fat-finger");
    // An explicit empty kind is preserved, not silently replaced by the default
    // (`?? "reversal"` keeps "", where `|| "reversal"` would override it).
    expect(reverseOf(makeTransfer({}), { ...meta, kind: "" }).kind).toBe("");
  });

  it("nets the affected account back to zero once both are posted", () => {
    const revenue = account("revenue", 45);
    const original = makeTransfer({
      amount: 5000,
      destination: revenue,
      id: 7,
      source: account("attendee", 88),
    });
    const reversal = makeTransfer({ ...reverseOf(original, meta), id: 8 });
    expect(balanceOf(revenue)([original])).toBe(5000);
    expect(balanceOf(revenue)([original, reversal])).toBe(0);
  });
});

describe("isInverseOf", () => {
  const original = makeTransfer({
    amount: 5000,
    destination: account("revenue", 45),
    source: account("attendee", 88),
  });

  it("accepts the leg that reverseOf builds", () => {
    expect(isInverseOf(reverseOf(original, meta), original)).toBe(true);
  });

  it("rejects a different amount or direction", () => {
    const inverse = reverseOf(original, meta);
    expect(isInverseOf({ ...inverse, amount: 4000 }, original)).toBe(false);
    // Same direction as the original (ends not swapped).
    expect(isInverseOf(original, original)).toBe(false);
  });
});
