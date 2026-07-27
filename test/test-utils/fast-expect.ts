/**
 * Speeds up @std/expect for the whole suite, without changing what any
 * assertion means. Loaded via `deno test --preload`, so every isolate gets it.
 */
import { expect } from "@std/expect";

/**
 * The built-in `toContain` pretty-prints the whole value on every call, even a
 * passing one — costly on the rendered pages this suite asserts against. This
 * keeps its semantics and builds the message only on failure.
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
 * The built-in deep comparison walks a typed array as a plain object, one
 * string key per index, so comparing 64KB of bytes costs ~566ms. This answers
 * for pairs of typed arrays instead, leaving every other pair untouched.
 *
 * Known difference: extra properties hung off a typed array are ignored, since
 * spotting them needs the `Object.keys` call that makes the built-in slow.
 */

/** A DataView has no elements to walk, so leave it to the built-in. */
const isTypedArray = (value: unknown): value is Uint8Array =>
  ArrayBuffer.isView(value) && !(value instanceof DataView);

/**
 * Compares numbers the way the built-in does: two NaNs are equal and `0`
 * equals `-0`. Applying that to every kind avoids a list of which kinds may be
 * read as raw bytes, which would go stale as new float kinds appear.
 */
const sameElements = (a: Uint8Array, b: Uint8Array): boolean =>
  a.every((value, index) => {
    const other = b[index] as number;
    return value === other || (Number.isNaN(value) && Number.isNaN(other));
  });

expect.addEqualityTesters([
  (a: unknown, b: unknown): boolean | undefined => {
    // Returning nothing hands the pair back to the built-in untouched.
    if (!isTypedArray(a) || !isTypedArray(b)) return;
    // The built-in also refuses mismatched kinds, including Buffer vs
    // Uint8Array and a subclass against its base.
    if (a.constructor !== b.constructor) return false;
    if (a.length !== b.length) return false;
    return sameElements(a, b);
  },
]);
