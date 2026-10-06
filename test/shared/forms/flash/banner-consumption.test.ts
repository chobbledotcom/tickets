import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { flashConsumed } from "#shared/flash-context.ts";
import { Flash } from "#shared/forms/flash.tsx";
import { withRequestContext } from "#test-utils/request-context.ts";

describe("Flash", () => {
  // Rendering any banner must mark the request's flash consumed so the Layout
  // backstop doesn't render it a second time. Each banner type triggers it.
  const consumesFor = async (props: {
    error?: string;
    success?: string;
    info?: string;
  }) =>
    await withRequestContext(() => {
      expect(flashConsumed()).toBe(false);
      String(Flash(props));
      return flashConsumed();
    });

  test("consumes the flash when rendering an error banner", async () => {
    expect(await consumesFor({ error: "boom" })).toBe(true);
  });

  test("consumes the flash when rendering a success banner", async () => {
    expect(await consumesFor({ success: "yay" })).toBe(true);
  });

  test("consumes the flash when rendering an info banner", async () => {
    expect(await consumesFor({ info: "fyi" })).toBe(true);
  });

  test("does not consume the flash when there is no message", async () => {
    const consumed = await withRequestContext(() => {
      String(Flash({}));
      return flashConsumed();
    });
    expect(consumed).toBe(false);
  });
});
