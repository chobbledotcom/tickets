import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  allReasons,
  firstReason,
  type Reason,
  reason,
} from "#shared/reasons.ts";

/** Rules over a number, used by most cases below. */
const negative: Reason<[number]> = (n) => (n < 0 ? `${n} is negative` : null);
const odd: Reason<[number]> = (n) => (n % 2 !== 0 ? `${n} is odd` : null);
const huge: Reason<[number]> = (n) => (n > 100 ? `${n} is huge` : null);
const RULES = [negative, odd, huge];

describe("firstReason", () => {
  test("returns null when no reason blocks", () => {
    expect(firstReason(RULES)(4)).toBe(null);
  });

  test("returns the blocking reason's message", () => {
    expect(firstReason(RULES)(200)).toBe("200 is huge");
  });

  test("declaration order is precedence when several reasons block", () => {
    // -3 is both negative and odd; the first-declared rule wins.
    expect(firstReason(RULES)(-3)).toBe("-3 is negative");
  });

  test("stops evaluating after the first blocking reason", () => {
    const calls: string[] = [];
    const spy =
      (name: string, message: string | null): Reason<[number]> =>
      () => {
        calls.push(name);
        return message;
      };
    const result = firstReason([
      spy("first", null),
      spy("second", "blocked by second"),
      spy("third", "blocked by third"),
    ])(1);
    expect(result).toBe("blocked by second");
    expect(calls).toEqual(["first", "second"]);
  });

  test("passes every argument to each reason", () => {
    const wrongLabel: Reason<[string, string]> = (value, label) =>
      value === label ? null : `${value} is not ${label}`;
    expect(firstReason([wrongLabel])("a", "b")).toBe("a is not b");
    expect(firstReason([wrongLabel])("a", "a")).toBe(null);
  });

  test("an empty rule list allows everything", () => {
    expect(firstReason<[number]>([])(7)).toBe(null);
  });
});

describe("allReasons", () => {
  test("returns every blocking message in declaration order", () => {
    expect(allReasons(RULES)(-201)).toEqual([
      "-201 is negative",
      "-201 is odd",
    ]);
    expect(allReasons(RULES)(999)).toEqual(["999 is odd", "999 is huge"]);
  });

  test("returns an empty list when nothing blocks", () => {
    expect(allReasons(RULES)(10)).toEqual([]);
  });
});

describe("reason", () => {
  test("renders the message only when the check blocks", () => {
    const tooLong = reason<[string]>(
      (s) => s.length > 3,
      (s) => `${s} is too long`,
    );
    expect(tooLong("abcd")).toBe("abcd is too long");
    expect(tooLong("abc")).toBe(null);
  });

  test("does not build the message for an allowed case", () => {
    let built = 0;
    const spy = reason<[number]>(
      (n) => n > 0,
      (n) => {
        built += 1;
        return `${n} blocked`;
      },
    );
    expect(spy(-1)).toBe(null);
    expect(built).toBe(0);
    expect(spy(1)).toBe("1 blocked");
    expect(built).toBe(1);
  });
});
