import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  BOOKING_FEE_INCOME,
  costAccount,
  isRowAccountType,
  isSingletonAccountType,
  modifierAccount,
  ROW_ACCOUNT_CONSTRUCTORS,
  revenueAccount,
  SINGLETON_ACCOUNTS,
  WORLD,
  WRITEOFF,
} from "#accounting/accounts.ts";

describe("accounting > accounts", () => {
  test("exposes the fixed singleton accounts", () => {
    expect(WORLD).toEqual({ id: "world", type: "external" });
    expect(BOOKING_FEE_INCOME).toEqual({ id: "booking", type: "fee_income" });
    expect(WRITEOFF).toEqual({ id: "default", type: "writeoff" });
  });

  // Each row builder maps its rows onto its OWN account type — a swapped `kind`
  // would silently divert money to another type's account.
  const builders: [
    name: string,
    build: (id: number) => unknown,
    type: string,
  ][] = [
    ["attendeeAccount", attendeeAccount, "attendee"],
    ["revenueAccount", revenueAccount, "revenue"],
    ["costAccount", costAccount, "cost"],
    ["modifierAccount", modifierAccount, "modifier"],
  ];

  for (const [builderName, build, type] of builders) {
    test(`${builderName} builds a ${type} account from a valid id`, () => {
      // 1 is the smallest accepted id — the boundary of the `id > 0` guard.
      expect(build(1)).toEqual({ id: "1", type });
      expect(build(3)).toEqual({ id: "3", type });
    });
  }

  const badIds: [name: string, id: number][] = [
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["unsafe (too large)", 2 ** 53],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
  ];

  for (const [builderName, build] of builders) {
    for (const [idName, id] of badIds) {
      test(`${builderName} rejects a ${idName} id`, () => {
        expect(() => build(id)).toThrow("positive safe integer");
      });
    }
  }

  describe("account-type guards", () => {
    test("isRowAccountType accepts the row-backed types only", () => {
      for (const type of ["attendee", "cost", "modifier", "revenue"]) {
        expect(isRowAccountType(type)).toBe(true);
      }
      for (const type of ["external", "fee_income", "writeoff", "", "nope"]) {
        expect(isRowAccountType(type)).toBe(false);
      }
    });

    test("isSingletonAccountType accepts the singleton types only", () => {
      for (const type of ["external", "fee_income", "writeoff"]) {
        expect(isSingletonAccountType(type)).toBe(true);
      }
      for (const type of ["attendee", "cost", "modifier", "revenue", "nope"]) {
        expect(isSingletonAccountType(type)).toBe(false);
      }
    });
  });

  describe("dispatch tables", () => {
    test("every singleton type resolves to its own account", () => {
      expect(SINGLETON_ACCOUNTS.external).toEqual(WORLD);
      expect(SINGLETON_ACCOUNTS.fee_income).toEqual(BOOKING_FEE_INCOME);
      expect(SINGLETON_ACCOUNTS.writeoff).toEqual(WRITEOFF);
    });

    test("every row type resolves to a constructor for its own account type", () => {
      expect(ROW_ACCOUNT_CONSTRUCTORS.attendee(5)).toEqual({
        id: "5",
        type: "attendee",
      });
      expect(ROW_ACCOUNT_CONSTRUCTORS.cost(5)).toEqual({
        id: "5",
        type: "cost",
      });
      expect(ROW_ACCOUNT_CONSTRUCTORS.modifier(5)).toEqual({
        id: "5",
        type: "modifier",
      });
      expect(ROW_ACCOUNT_CONSTRUCTORS.revenue(5)).toEqual({
        id: "5",
        type: "revenue",
      });
    });
  });
});
