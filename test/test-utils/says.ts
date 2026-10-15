import { assert, assertArrayIncludes, assertStringIncludes } from "@std/assert";

/**
 * The one-line replacements for the removed `expect().toContain` override.
 *
 * Each helper guards a nullish actual, because the old override answered the
 * same way through optional chaining. A nullish text or list never holds the
 * part, and absence is never proven, so every helper fails on a nullish
 * actual.
 */

/** Fails unless the text holds the part. */
export const says = (
  text: string | null | undefined,
  part: string,
  msg?: string,
): void => assertStringIncludes(text ?? "", part, msg);

/** Fails unless the text leaves the part out. */
export const saysNot = (
  text: string | null | undefined,
  part: string,
  msg?: string,
): void => assert(text?.includes(part) === false, msg);

/** Fails unless the list holds the item. */
export const has = (
  list: readonly unknown[] | null | undefined,
  item: unknown,
  msg?: string,
): void => assertArrayIncludes(list ?? [], [item], msg);

/** Fails if the list holds the item. A nullish list never proved absence,
 * so it fails like `saysNot` does. */
export const hasNot = (
  list: readonly unknown[] | null | undefined,
  item: unknown,
  msg?: string,
): void => assert(list?.includes(item) === false, msg);
