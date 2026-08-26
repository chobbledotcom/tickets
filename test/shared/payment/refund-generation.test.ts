import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { requireRefundGeneration } from "#payment/refund-generation.ts";

const REFUSAL = "Refund generation must be a positive safe integer";

describe("refusing a refund generation that cannot be stored exactly", () => {
  for (const generation of [1, 2, Number.MAX_SAFE_INTEGER]) {
    test(`accepts generation ${generation}`, () => {
      expect(requireRefundGeneration(generation)).toBeUndefined();
    });
  }

  // A generation counts the commands sent for one refund, so it starts at one
  // and every later one must land on its own exact whole number.
  for (const [name, generation] of [
    ["counts nothing", 0],
    ["counts backwards", -1],
    ["falls between two commands", 1.5],
    ["is not a number at all", Number.NaN],
    ["is too large to hold exactly", Number.MAX_SAFE_INTEGER + 1],
    ["has no end", Number.POSITIVE_INFINITY],
  ] as const) {
    test(`refuses a generation that ${name}`, () => {
      expect(() => requireRefundGeneration(generation)).toThrow(REFUSAL);
    });
  }
});
