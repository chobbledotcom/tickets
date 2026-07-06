import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  isNonEmptyString,
  type NonEmptyString,
  nonEmptyString,
  parseNonEmptyString,
} from "#shared/validation/string.ts";

const acceptNonEmpty = (value: NonEmptyString): string => value;

describe("validation/string", () => {
  test("brands a non-empty string while keeping normal string behaviour", () => {
    const value = nonEmptyString("hello");
    expect(acceptNonEmpty(value)).toBe("hello");
    expect(value.toUpperCase()).toBe("HELLO");
  });

  test("parses and guards dynamic strings", () => {
    expect(parseNonEmptyString("file.webp")).toBe("file.webp");
    expect(parseNonEmptyString("")).toBeNull();
    expect(isNonEmptyString("file.webp")).toBe(true);
    expect(isNonEmptyString("")).toBe(false);
  });

  test("throws with the field name for invalid dynamic strings", () => {
    const empty: string = "";
    expect(() => nonEmptyString(empty, "image filename")).toThrow(
      "image filename must be non-empty",
    );
  });
});
