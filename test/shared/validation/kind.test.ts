import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { kindObject } from "#shared/validation/kind.ts";

describe("a choice that is only its own name", () => {
  test("accepts exactly its own kind", () => {
    expect(
      v.parse(kindObject("multiple_charges"), {
        kind: "multiple_charges",
      }),
    ).toEqual({ kind: "multiple_charges" });
  });

  test("refuses another kind's name", () => {
    expect(
      v.safeParse(kindObject("multiple_charges"), {
        kind: "partial_refund",
      }).success,
    ).toBe(false);
  });

  test("refuses extra fields, so an arm carrying data cannot pose as a bare name", () => {
    expect(
      v.safeParse(kindObject("multiple_charges"), {
        detail: "smuggled",
        kind: "multiple_charges",
      }).success,
    ).toBe(false);
  });
});
