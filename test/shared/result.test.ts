import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  errorResult,
  okResult,
  parseOptionalResult,
  requireSuccess,
} from "#shared/result.ts";

describe("result helpers", () => {
  test("creates success and error result shapes", () => {
    expect(okResult(42)).toEqual({ ok: true, value: 42 });
    expect(errorResult("Nope")).toEqual({ error: "Nope", ok: false });
  });

  test("returns undefined without parsing an absent optional value", () => {
    let parsed = false;
    expect(
      parseOptionalResult(undefined, () => {
        parsed = true;
        return okResult(1);
      }),
    ).toEqual(okResult(undefined));
    expect(parsed).toBe(false);
  });

  test("parses a present optional value", () => {
    expect(
      parseOptionalResult("12", (value) => okResult(Number(value))),
    ).toEqual(okResult(12));
  });

  test("accepts a successful result", () => {
    expect(requireSuccess(okResult(42))).toBe(42);
  });

  test("throws the boundary error from a failed result", () => {
    expect(() =>
      requireSuccess({ error: "Invalid setting", ok: false }),
    ).toThrow("Invalid setting");
  });

  test("throws typed error codes with context", () => {
    expect(() =>
      requireSuccess(
        errorResult([{ code: "empty_reference" }, { code: "self_transfer" }]),
        "Post transfer",
      ),
    ).toThrow("Post transfer: empty_reference, self_transfer");
  });

  test("throws one typed error code", () => {
    expect(() =>
      requireSuccess(errorResult([{ code: "empty_reference" }])),
    ).toThrow("empty_reference");
  });

  test("does not replace an explicit empty message with a code", () => {
    expect(() =>
      requireSuccess(errorResult({ code: "fallback", message: "" })),
    ).toThrow("Failed result is missing an error");
  });

  test("rejects an empty error message", () => {
    expect(() => requireSuccess(errorResult(""))).toThrow(
      "Failed result is missing an error",
    );
  });

  test("uses an Error name when its message is empty", () => {
    expect(() => requireSuccess(errorResult(new TypeError()))).toThrow(
      "TypeError",
    );
  });

  test("rejects an error list containing a malformed entry", () => {
    expect(() =>
      requireSuccess(errorResult([{ code: "valid" }, null])),
    ).toThrow("Failed result is missing an error");
  });

  test("rejects a malformed failed result with a useful message", () => {
    const malformed = { ok: false } as unknown as ReturnType<
      typeof errorResult<string>
    >;
    expect(() => requireSuccess(malformed)).toThrow(
      "Failed result is missing an error",
    );
  });
});
