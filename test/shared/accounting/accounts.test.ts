import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attendeeAccount,
  BOOKING_FEE_INCOME,
  modifierAccount,
  revenueAccount,
  WORLD,
} from "#shared/accounting/accounts.ts";

describe("accounting > accounts", () => {
  test("exposes the fixed singleton accounts", () => {
    expect(WORLD).toEqual({ id: "world", type: "external" });
    expect(BOOKING_FEE_INCOME).toEqual({ id: "booking", type: "fee_income" });
  });

  test("builds row-backed accounts from a valid id", () => {
    expect(attendeeAccount(3)).toEqual({ id: "3", type: "attendee" });
    expect(revenueAccount(7)).toEqual({ id: "7", type: "revenue" });
    expect(modifierAccount(11)).toEqual({ id: "11", type: "modifier" });
  });

  const builders: [name: string, build: (id: number) => unknown][] = [
    ["attendeeAccount", attendeeAccount],
    ["revenueAccount", revenueAccount],
    ["modifierAccount", modifierAccount],
  ];

  const badIds: [name: string, id: number][] = [
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["unsafe (too large)", 2 ** 53],
  ];

  for (const [builderName, build] of builders) {
    for (const [idName, id] of badIds) {
      test(`${builderName} rejects a ${idName} id`, () => {
        expect(() => build(id)).toThrow("positive safe integer");
      });
    }
  }
});
