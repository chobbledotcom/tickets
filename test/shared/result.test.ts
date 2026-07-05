import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { errorResult, okResult } from "#shared/result.ts";

describe("result helpers", () => {
  test("creates success and error result shapes", () => {
    expect(okResult(42)).toEqual({ ok: true, value: 42 });
    expect(errorResult("Nope")).toEqual({ error: "Nope", ok: false });
  });
});
