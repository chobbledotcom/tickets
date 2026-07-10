/**
 * The overridden `toContain` (test/test-utils/fast-expect.ts) must keep the
 * built-in's pass/fail semantics while only building its failure message when
 * an assertion actually fails — that message path never runs in a passing
 * suite, so it is exercised directly here.
 */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import "#test-utils"; // installs the fast toContain override

const failureMessage = (assert: () => void): string => {
  try {
    assert();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the assertion to fail");
};

describe("fast toContain override", () => {
  test("passes when a string contains the needle", () => {
    expect("abcdef").toContain("cde");
  });

  test("passes when an array contains the item", () => {
    expect([1, 2, 3]).toContain(2);
  });

  test(".not inverts the check", () => {
    expect("abcdef").not.toContain("xyz");
  });

  test("failure names the needle and quotes the searched value", () => {
    const message = failureMessage(() => {
      expect("some short page").toContain("missing-needle");
    });
    expect(message).toContain("doesn't contain");
    expect(message).toContain('"missing-needle"');
    expect(message).toContain('"some short page"');
  });

  test("a failed .not names the found needle", () => {
    const message = failureMessage(() => {
      expect("value with needle").not.toContain("needle");
    });
    expect(message).toContain("contains");
    expect(message).toContain('"needle"');
  });

  test("a huge searched value is truncated in the failure message", () => {
    const huge = "x".repeat(100_000);
    const message = failureMessage(() => {
      expect(huge).toContain("missing");
    });
    expect(message).toContain("(100000 chars total)");
    expect(message.length).toBeLessThan(10_000);
  });

  test("a non-string value is inspected, not sliced", () => {
    const message = failureMessage(() => {
      expect([1, 2, 3]).toContain(9);
    });
    expect(message).toContain("[ 1, 2, 3 ]");
    expect(message).toContain("9");
  });

  test("a value with no includes method never passes", () => {
    const message = failureMessage(() => {
      expect(42).toContain(4);
    });
    expect(message).toContain("doesn't contain");
  });
});
