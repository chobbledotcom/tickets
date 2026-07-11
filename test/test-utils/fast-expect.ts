/**
 * Fast `toContain` for the whole suite.
 *
 * @std/expect's built-in `toContain` pretty-prints (`format`s) the ENTIRE
 * value on every call — even when the assertion passes. On a full rendered
 * page (~100-500KB of HTML) that costs ~35ms per assertion, and the suite
 * makes thousands of `expect(html).toContain(...)` assertions, so the eager
 * formatting alone burned minutes of CPU per run. This override keeps the
 * built-in's exact pass/fail semantics (the value's own `.includes`, so
 * strings and arrays both work, and `.not` inverts as usual) but builds the
 * failure message only when the assertion actually fails — and truncates a
 * huge value there so the error stays readable.
 *
 * Loaded via `deno test --preload` (wired up in `scripts/test-harness.ts` and
 * `scripts/mutation/runner.ts`), so every test isolate installs the fast
 * matcher automatically.
 */
import { expect } from "@std/expect";

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
