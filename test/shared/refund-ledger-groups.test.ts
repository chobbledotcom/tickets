import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { WORLD } from "#shared/accounting/accounts.ts";
import { accountRefundGroups } from "#shared/refund-ledger.ts";
import { leg, refundLegsOf } from "./refund-ledger-helpers.ts";

describe("refund-ledger > accountRefundGroups", () => {
  test("returns the single booking group's legs", () => {
    const sale = leg({ kind: "sale", reference: "sale" });
    const pay = leg({ kind: "payment", reference: "pay", source: WORLD });
    expect(accountRefundGroups([sale, pay])).toEqual([[sale, pay]]);
  });

  test("returns a sale-less paid order (surcharge, no sale leg)", () => {
    const mod = leg({ kind: "modifier", reference: "mod" });
    const pay = leg({ kind: "payment", reference: "pay", source: WORLD });
    expect(accountRefundGroups([mod, pay])).toEqual([[mod, pay]]);
  });

  test("returns a payment-only balance group", () => {
    const pay = leg({ kind: "payment", source: WORLD });
    expect(accountRefundGroups([pay])).toEqual([[pay]]);
  });

  test("returns no groups for an empty account", () => {
    expect(accountRefundGroups([])).toEqual([]);
  });

  test("returns booking and balance groups together", () => {
    const sale = leg({ eventGroup: "book", kind: "sale", reference: "sale" });
    const deposit = leg({
      eventGroup: "book",
      kind: "payment",
      reference: "dep",
      source: WORLD,
    });
    const balance = leg({
      eventGroup: "bal",
      kind: "payment",
      reference: "bal",
      source: WORLD,
    });
    expect(accountRefundGroups([sale, deposit, balance])).toEqual([
      [sale, deposit],
      [balance],
    ]);
  });

  test("returns each booking order when two share the attendee", () => {
    const first = leg({ eventGroup: "g1", reference: "s1" });
    const second = leg({ eventGroup: "g2", reference: "s2" });
    expect(accountRefundGroups([first, second])).toEqual([[first], [second]]);
  });

  test("ignores existing refund groups", () => {
    const sale = leg({ eventGroup: "book", kind: "sale", reference: "sale" });
    const refund = leg({
      eventGroup: "refund-book",
      kind: "refund_sale",
      reference: "refund-sale",
    });
    expect(accountRefundGroups([sale, refund])).toEqual([[sale]]);
  });

  test("keeps legacy legs whose kind is missing", () => {
    const base = leg({ reference: "legacy" });
    const { kind: _kind, ...legacy } = base;
    expect(accountRefundGroups([legacy])).toEqual([[legacy]]);
  });

  test("refund helper ignores legacy legs whose kind is missing", () => {
    const refund = leg({ kind: "refund_cash", reference: "refund" });
    const base = leg({ reference: "legacy" });
    const { kind: _kind, ...legacy } = base;
    expect(refundLegsOf([refund, legacy])).toEqual([refund]);
  });
});
