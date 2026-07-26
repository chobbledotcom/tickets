import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { flashConsumed, runWithFlashContext } from "#shared/flash-context.ts";
import { Flash } from "#shared/forms/flash.tsx";

describe("Flash", () => {
  // Rendering any banner must mark the request's flash consumed so the Layout
  // backstop doesn't render it a second time. Each banner type triggers it.
  const consumesFor = (props: {
    error?: string;
    success?: string;
    info?: string;
  }) =>
    runWithFlashContext(() => {
      expect(flashConsumed()).toBe(false);
      String(Flash(props));
      return flashConsumed();
    });

  test("consumes the flash when rendering an error banner", () => {
    expect(consumesFor({ error: "boom" })).toBe(true);
  });

  test("consumes the flash when rendering a success banner", () => {
    expect(consumesFor({ success: "yay" })).toBe(true);
  });

  test("consumes the flash when rendering an info banner", () => {
    expect(consumesFor({ info: "fyi" })).toBe(true);
  });

  test("does not consume the flash when there is no message", () => {
    const consumed = runWithFlashContext(() => {
      String(Flash({}));
      return flashConsumed();
    });
    expect(consumed).toBe(false);
  });
});
