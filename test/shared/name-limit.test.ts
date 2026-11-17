import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { nameLengthError } from "#shared/name-limit.ts";

describe("the name length limit", () => {
  test("accepts a name inside or at the input limit", () => {
    for (const name of ["Holiday", "x".repeat(MAX_INPUT_LENGTH)]) {
      expect(nameLengthError(name)).toBeNull();
    }
  });

  test("refuses a name past the input limit with the shared message", () => {
    expect(nameLengthError("x".repeat(MAX_INPUT_LENGTH + 1))).toBe(
      `Name must be ${MAX_INPUT_LENGTH} characters or fewer`,
    );
  });
});
