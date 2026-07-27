/**
 * Two ways @std/expect is made fast for the whole suite: `toContain`, and
 * comparing byte arrays.
 *
 * Loaded via `deno test --preload` (wired up in `scripts/test-harness.ts` and
 * `scripts/mutation/runner.ts`), so every test isolate installs both
 * automatically and no assertion has to be written differently to get them.
 */
import { equals as bytesEqual } from "@std/bytes";
import { expect } from "@std/expect";

/**
 * ## Fast `toContain`
 *
 * The built-in pretty-prints (`format`s) the ENTIRE value on every call — even
 * when the assertion passes. On a full rendered page (~100-500KB of HTML) that
 * costs ~35ms per assertion, and the suite makes thousands of
 * `expect(html).toContain(...)` assertions, so the eager formatting alone
 * burned minutes of CPU per run. This override keeps the built-in's exact
 * pass/fail semantics (the value's own `.includes`, so strings and arrays both
 * work, and `.not` inverts as usual) but builds the failure message only when
 * the assertion actually fails — and truncates a huge value there so the error
 * stays readable.
 */

/** Show at most this much of the searched value in a failure message. */
const MAX_SHOWN_VALUE_CHARS = 2_000;

const describeValue = (value: unknown): string => {
  if (typeof value !== "string") return Deno.inspect(value, { depth: 2 });
  if (value.length <= MAX_SHOWN_VALUE_CHARS) return JSON.stringify(value);
  return `${JSON.stringify(value.slice(0, MAX_SHOWN_VALUE_CHARS))}… (${value.length} chars total)`;
};

expect.extend({
  toContain(context, expected) {
    const pass = Boolean(
      (
        context.value as { includes?: (needle: unknown) => boolean }
      )?.includes?.(expected),
    );
    return {
      message: () =>
        `The value ${describeValue(context.value)} ${
          pass ? "contains" : "doesn't contain"
        } the expected item ${describeValue(expected)}`,
      pass,
    };
  },
});

/**
 * ## Fast byte-array comparison
 *
 * The built-in deep comparison has no idea what a typed array is, so it treats
 * one as a plain object: it takes `Object.keys` of both sides (a string per
 * index — "0", "1", … "65535"), spreads both into one merged object, lists
 * *that* object's keys, then recurses once per element. Comparing 64KB of
 * bytes costs about 566ms — more, on its own, than the 500ms at which the
 * suite flags a test as slow.
 *
 * `addEqualityTesters` is the supported way in: a tester runs before all of
 * that and can answer for the pairs it recognises, returning `undefined` to
 * leave everything else exactly as it was. Every matcher built on the deep
 * comparison — `toEqual`, `toStrictEqual`, `toContainEqual` — gets this, so no
 * assertion in the suite has to change. The same 64KB comparison now takes
 * about 0.05ms.
 */

/** The bytes a view actually covers — not its whole buffer, so a `subarray`
 * compares by what it shows rather than what it was cut from. */
const bytesOf = (view: ArrayBufferView): Uint8Array =>
  new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

/** Every typed array except the float kinds, whose values do not compare
 * byte-for-byte — see {@link sameNumbers}. */
const comparesByBytes = (view: ArrayBufferView): boolean =>
  !(view instanceof Float32Array || view instanceof Float64Array);

/**
 * Compare float arrays a number at a time, the way the built-in comparison
 * does: two NaNs count as equal, and `0` equals `-0`. Neither of those holds
 * for the bytes underneath, so floats cannot take the fast path.
 */
const sameNumbers = (a: Float32Array | Float64Array, b: typeof a): boolean => {
  for (let index = 0; index < a.length; index++) {
    const left = a[index] as number;
    const right = b[index] as number;
    if (left !== right && !(Number.isNaN(left) && Number.isNaN(right))) {
      return false;
    }
  }
  return true;
};

/** A typed array — a view over bytes with a length. A DataView is not one:
 * it has no elements to compare, and the built-in handles it. */
const isTypedArray = (value: unknown): value is ArrayBufferView =>
  ArrayBuffer.isView(value) && !(value instanceof DataView);

expect.addEqualityTesters([
  (a: unknown, b: unknown): boolean | undefined => {
    // Anything that is not a pair of typed arrays is none of this tester's
    // business, and `undefined` hands it back untouched.
    if (!isTypedArray(a) || !isTypedArray(b)) return;
    // Different kinds are never equal, which is what the built-in says too —
    // it compares `[object Uint8Array]` against `[object Int8Array]` first.
    if (a.constructor !== b.constructor) return false;
    if (a.byteLength !== b.byteLength) return false;
    return comparesByBytes(a)
      ? bytesEqual(bytesOf(a), bytesOf(b))
      : sameNumbers(a as Float64Array, b as Float64Array);
  },
]);
