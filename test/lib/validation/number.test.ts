import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { parsePositiveIntId } from "#shared/validation/number.ts";

describe("parsePositiveIntId", () => {
  test("parses plain positive integers, dropping leading zeros", () => {
    expect(parsePositiveIntId("5")).toBe(5);
    expect(parsePositiveIntId("12")).toBe(12);
    expect(parsePositiveIntId("007")).toBe(7);
  });

  test("rejects zero, blanks and non-digit junk", () => {
    expect(parsePositiveIntId("0")).toBeNull();
    expect(parsePositiveIntId("")).toBeNull();
    // Lenient parseInt would have returned 5 for "5abc" — strict parsing won't.
    expect(parsePositiveIntId("5abc")).toBeNull();
    expect(parsePositiveIntId("abc")).toBeNull();
  });

  test("rejects signs and surrounding whitespace", () => {
    expect(parsePositiveIntId("-2")).toBeNull();
    expect(parsePositiveIntId("+5")).toBeNull();
    expect(parsePositiveIntId(" 5")).toBeNull();
    expect(parsePositiveIntId("5 ")).toBeNull();
  });
});
