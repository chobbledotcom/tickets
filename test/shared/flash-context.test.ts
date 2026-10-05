import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { setFlashContext } from "#shared/flash-context.ts";

describe("flash context", () => {
  test("setFlashContext refuses to run outside a request scope", () => {
    // Only the request middleware populates the flash; a stray call would
    // silently drop the message, so it must fail loudly instead.
    expect(() => setFlashContext({ success: "hi" })).toThrow(/request scope/);
  });
});
