/**
 * Speeds up @std/expect's deep comparison for the whole suite, without
 * changing what any assertion means. Loaded via `deno test --preload`, so
 * every isolate gets it.
 */
import { expect } from "@std/expect";

/**
 * The built-in deep comparison walks a typed array as a plain object, one
 * string key per index, so comparing 64KB of bytes costs ~566ms. This answers
 * for pairs of typed arrays instead, leaving every other pair untouched.
 *
 * The built-in also walks every own property beyond the indices, string or
 * symbol. A pair where either side carries such properties goes back to it,
 * so the fast path never calls a pair equal when the built-in would not.
 */

/** A DataView has no elements to walk, so leave it to the built-in. */
const isTypedArray = (value: unknown): value is Uint8Array =>
  ArrayBuffer.isView(value) && !(value instanceof DataView);

/**
 * Tells whether the array carries own enumerable properties beyond its
 * indices. The key count spots the string extras; symbols never sit on a
 * typed array unless someone adds one.
 */
const hasExtraOwnProperties = (value: Uint8Array): boolean =>
  Object.keys(value).length !== value.length ||
  Object.getOwnPropertySymbols(value).length > 0;

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
    if (hasExtraOwnProperties(a) || hasExtraOwnProperties(b)) return;
    return sameElements(a, b);
  },
]);
