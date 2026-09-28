import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { withStaticAssetBuildLock } from "#scripts/static-assets/build-lock.ts";

describe("withStaticAssetBuildLock", () => {
  test("runs the body once and returns its result", async () => {
    let runs = 0;
    const value = await withStaticAssetBuildLock(() => {
      runs++;
      return Promise.resolve("kept");
    });
    expect(value).toBe("kept");
    expect(runs).toBe(1);
  });
});
