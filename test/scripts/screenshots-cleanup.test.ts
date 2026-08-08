import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { withWholePaintGroups } from "#scripts/screenshots/layers.ts";
import { addScreenshotStyle } from "#scripts/screenshots/style.ts";

describe("screenshot cleanup", () => {
  test("removes the route when the document style cannot be added", async () => {
    const styleError = new Error("style failed");
    let unroutes = 0;
    const page = {
      addStyleTag: () => Promise.reject(styleError),
      route: () => Promise.resolve(),
      unroute: () => {
        unroutes += 1;
        return Promise.resolve();
      },
      url: () => "https://tickets.test/page",
    } as never;

    await expect(addScreenshotStyle(page, "body {}")).rejects.toBe(styleError);
    expect(unroutes).toBe(1);
  });

  test("keeps the capture error when removing paint marks also fails", async () => {
    const captureError = new Error("capture failed");
    const cleanupError = new Error("mark cleanup failed");
    let evaluations = 0;
    const page = {
      evaluate: () => {
        evaluations += 1;
        return evaluations === 1
          ? Promise.resolve()
          : Promise.reject(cleanupError);
      },
    } as never;

    let thrown: unknown;
    try {
      await withWholePaintGroups(page, () => Promise.reject(captureError));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([
      captureError,
      cleanupError,
    ]);
  });
});
