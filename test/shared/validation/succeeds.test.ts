import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { succeeds } from "#shared/validation/succeeds.ts";

describe("succeeds", () => {
  test("answers true when the action completes", () => {
    expect(succeeds(() => JSON.parse("{}"))).toBe(true);
    expect(succeeds(() => undefined)).toBe(true);
  });

  test("answers false when the action throws", () => {
    expect(succeeds(() => JSON.parse("{"))).toBe(false);
    expect(
      succeeds((): never => {
        throw new Error("no");
      }),
    ).toBe(false);
  });
});
