import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { errorResult, okResult, requireSuccess } from "#shared/result.ts";

describe("result helpers", () => {
  test("creates success and error result shapes", () => {
    expect(okResult(42)).toEqual({ ok: true, value: 42 });
    expect(errorResult("Nope")).toEqual({ error: "Nope", ok: false });
  });

  test("accepts a successful result", () => {
    expect(() => requireSuccess({ ok: true })).not.toThrow();
  });

  test("throws the boundary error from a failed result", () => {
    expect(() =>
      requireSuccess({ error: "Invalid setting", ok: false }),
    ).toThrow("Invalid setting");
  });
});
