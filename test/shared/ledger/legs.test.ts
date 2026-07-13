import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { account } from "#shared/ledger/account.ts";
import { legMatches, sumLegs } from "#shared/ledger/legs.ts";
import { makeTransfer } from "#test-utils/transfer-factory.ts";

const world = account("external", "world");
const attendee = account("attendee", 88);
const revenue = account("revenue", 45);

const saleLeg = makeTransfer({
  amount: 5000,
  destination: revenue,
  kind: "sale",
  source: attendee,
});
const paymentLeg = makeTransfer({
  amount: 3000,
  destination: attendee,
  kind: "payment",
  source: world,
});

describe("legMatches", () => {
  it("matches on kind alone when only kind is given", () => {
    expect(legMatches({ kind: "sale" })(saleLeg)).toBe(true);
    expect(legMatches({ kind: "sale" })(paymentLeg)).toBe(false);
  });

  it("pins the source account when `from` is given", () => {
    expect(legMatches({ from: world, kind: "payment" })(paymentLeg)).toBe(true);
    // Same kind but sourced from the attendee, not the world.
    expect(
      legMatches({ from: world, kind: "payment" })(
        makeTransfer({ kind: "payment", source: attendee }),
      ),
    ).toBe(false);
  });

  it("pins the destination account when `to` is given", () => {
    expect(legMatches({ kind: "sale", to: revenue })(saleLeg)).toBe(true);
    expect(
      legMatches({ kind: "sale", to: revenue })(
        makeTransfer({ destination: account("revenue", 999), kind: "sale" }),
      ),
    ).toBe(false);
  });

  it("requires every named field — kind, source, and destination all match", () => {
    const spec = { from: attendee, kind: "sale", to: revenue };
    expect(legMatches(spec)(saleLeg)).toBe(true);
    // Right kind and source, wrong destination account id.
    expect(
      legMatches(spec)(
        makeTransfer({
          destination: account("revenue", 46),
          kind: "sale",
          source: attendee,
        }),
      ),
    ).toBe(false);
    // Right kind and destination, wrong source account.
    expect(
      legMatches(spec)(
        makeTransfer({ destination: revenue, kind: "sale", source: world }),
      ),
    ).toBe(false);
  });

  it("an empty spec matches every leg", () => {
    expect(legMatches({})(saleLeg)).toBe(true);
    expect(legMatches({})(paymentLeg)).toBe(true);
  });
});

describe("sumLegs", () => {
  const legs = [
    saleLeg,
    paymentLeg,
    makeTransfer({
      amount: 2000,
      destination: revenue,
      kind: "sale",
      source: attendee,
    }),
  ];

  it("sums the amounts of the legs the predicate keeps", () => {
    expect(sumLegs(legMatches({ kind: "sale" }))(legs)).toBe(7000);
  });

  it("sums only the legs matching every field of a full spec", () => {
    expect(
      sumLegs(legMatches({ from: attendee, kind: "sale", to: revenue }))(legs),
    ).toBe(7000);
  });

  it("is 0 when no leg matches", () => {
    expect(sumLegs(legMatches({ kind: "refund_cash" }))(legs)).toBe(0);
  });

  it("is 0 over an empty slice", () => {
    expect(sumLegs(legMatches({ kind: "sale" }))([])).toBe(0);
  });
});
