import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { remembered } from "#shared/remembered.ts";

describe("remembered", () => {
  test("answers each input once and repeats its first answer", () => {
    let callCount = 0;
    const double = remembered((input: number) => {
      callCount++;
      return input * 2;
    });

    expect(double(3)).toBe(6);
    expect(double(3)).toBe(6);
    expect(double(4)).toBe(8);
    expect(callCount).toBe(2);
  });

  test("keeps an undefined answer, so the same input costs one computation", () => {
    let callCount = 0;
    const classify = remembered((input: string) => {
      callCount++;
      return input === "unknown" ? undefined : input;
    });

    expect(classify("unknown")).toBeUndefined();
    expect(classify("unknown")).toBeUndefined();
    expect(callCount).toBe(1);
    expect(classify("known")).toBe("known");
    expect(callCount).toBe(2);
  });

  test("distinguishes equal-length string inputs", () => {
    const upper = remembered((input: string) => input.toUpperCase());

    expect(upper("ab")).toBe("AB");
    expect(upper("ba")).toBe("BA");
  });
});
