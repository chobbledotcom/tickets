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
