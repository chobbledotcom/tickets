import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { waitForScreenshotPage } from "#scripts/screenshots/readiness.ts";

describe("screenshot page readiness", () => {
  test("waits for resources, fonts, and two browser paints in order", async () => {
    const calls: string[] = [];
    await waitForScreenshotPage({
      evaluate: (expression) => {
        calls.push(expression);
        return Promise.resolve();
      },
      waitForFunction: (expression) => {
        calls.push(expression);
        return Promise.resolve();
      },
      waitForLoadState: (state) => {
        calls.push(state);
        return Promise.resolve();
      },
    });

    expect(calls).toEqual([
      "load",
      'document.fonts.status === "loaded"',
      `new Promise((resolve) =>
  requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
    ]);
  });
});
