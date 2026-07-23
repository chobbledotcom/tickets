import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { parseOrNull, parseOrThrow } from "#shared/validation/parse.ts";
import { thrownError } from "#test-utils/errors.ts";

const trimmedText = v.pipe(v.string(), v.trim());

describe("schema parsing", () => {
  test("returns a parsed value", () => {
    expect(
      parseOrThrow(trimmedText, " value ", () => new Error("invalid")),
    ).toBe("value");
  });

  test("throws the requested error for an invalid value", () => {
    const expected = new Error("invalid value");
    const error = thrownError(() =>
      parseOrThrow(trimmedText, 3, () => expected),
    );
    expect(error).toBe(expected);
  });

  test("returns null for an invalid value", () => {
    expect(parseOrNull(trimmedText, 3)).toBeNull();
  });
});
