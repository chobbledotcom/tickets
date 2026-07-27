/**
 * The overridden `toContain` (test/test-utils/fast-expect.ts) must keep the
 * built-in's pass/fail semantics while only building its failure message when
 * an assertion actually fails — that message path never runs in a passing
 * suite, so it is exercised directly here.
 */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import "#test-utils/fast-expect.ts"; // installs the fast toContain override

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

describe("fast byte-array comparison", () => {
  const bytes = (...values: number[]) => Uint8Array.from(values);

  test("equal byte arrays match", () => {
    expect(bytes(1, 2, 3)).toEqual(bytes(1, 2, 3));
  });

  test("differing contents do not match", () => {
    expect(bytes(1, 2, 3)).not.toEqual(bytes(1, 9, 3));
  });

  test("differing lengths do not match", () => {
    expect(bytes(1, 2)).not.toEqual(bytes(1, 2, 3));
  });

  test("empty arrays match", () => {
    expect(new Uint8Array(0)).toEqual(new Uint8Array(0));
  });

  // The built-in refuses these too, by comparing "[object Uint8Array]" against
  // "[object Int8Array]". The fast path must not become more generous.
  test("two kinds holding the same numbers do not match", () => {
    expect(bytes(1, 2)).not.toEqual(
      Int8Array.from([1, 2]) as unknown as Uint8Array,
    );
  });

  test("a byte array does not match a plain array of the same numbers", () => {
    expect(bytes(1, 2)).not.toEqual([1, 2] as unknown as Uint8Array);
  });

  // A view compares by the bytes it shows, not by the buffer it was cut from.
  test("a subarray matches a standalone array of the bytes it shows", () => {
    expect(bytes(9, 1, 2).subarray(1)).toEqual(bytes(1, 2));
  });

  test("two subarrays of one buffer match only where they overlap", () => {
    const buffer = bytes(1, 2, 1, 2);
    expect(buffer.subarray(0, 2)).toEqual(buffer.subarray(2));
    expect(buffer.subarray(0, 2)).not.toEqual(buffer.subarray(1, 3));
  });

  test("wider integer kinds compare by value", () => {
    expect(Uint32Array.from([1, 70000])).toEqual(Uint32Array.from([1, 70000]));
    expect(Uint32Array.from([70000])).not.toEqual(Uint32Array.from([70001]));
  });

  test("bigint kinds compare by value", () => {
    expect(BigInt64Array.from([1n, -2n])).toEqual(
      BigInt64Array.from([1n, -2n]),
    );
    expect(BigInt64Array.from([1n])).not.toEqual(BigInt64Array.from([2n]));
  });

  // Floats keep the built-in's number rules, which the bytes underneath do not
  // follow: these two hold different bits but are equal numbers, and NaN is
  // equal to itself here even though it is equal to nothing in plain JS.
  test("zero and minus zero match in a float array", () => {
    expect(Float64Array.from([0])).toEqual(Float64Array.from([-0]));
  });

  test("NaN matches itself in a float array", () => {
    expect(Float64Array.from([Number.NaN])).toEqual(
      Float64Array.from([Number.NaN]),
    );
  });

  test("differing floats do not match", () => {
    expect(Float64Array.from([1.5])).not.toEqual(Float64Array.from([1.25]));
    expect(Float32Array.from([1.5])).not.toEqual(Float32Array.from([1.25]));
  });

  // The tester answers only for pairs of typed arrays, so everything else
  // keeps the comparison it always had.
  test("values that are not typed arrays are compared as before", () => {
    expect({ a: 1, b: [1, 2] }).toEqual({ a: 1, b: [1, 2] });
    expect(new Map([[1, "a"]])).toEqual(new Map([[1, "a"]]));
    expect({ a: 1 }).not.toEqual({ a: 2 });
    expect(new DataView(new ArrayBuffer(2))).toEqual(
      new DataView(new ArrayBuffer(2)),
    );
  });

  test("a byte array nested in an object is compared by its contents", () => {
    expect({ blob: bytes(1, 2) }).toEqual({ blob: bytes(1, 2) });
    expect({ blob: bytes(1, 2) }).not.toEqual({ blob: bytes(1, 3) });
  });

  // Asymmetric matchers are resolved before any equality tester runs, so they
  // still win over the fast path.
  test("an asymmetric matcher still matches a byte array", () => {
    expect(bytes(1, 2)).toEqual(expect.any(Uint8Array));
    expect({ blob: bytes(1, 2) }).toEqual({ blob: expect.any(Uint8Array) });
  });

  test("every matcher built on deep comparison gets the fast path", () => {
    expect(bytes(1, 2)).toStrictEqual(bytes(1, 2));
    expect([bytes(1, 2)]).toContainEqual(bytes(1, 2));
    expect([bytes(1, 2)]).not.toContainEqual(bytes(1, 3));
  });
});
