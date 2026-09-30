// test-groups: run-alone — when the build record is missing or stale, this
// test runs the real build, which starts esbuild's service process. Disposing
// the build kills that process, but npm esbuild's stop() answers before the
// process has exited, so its wait and read operations are still open when the
// test ends. Alone, they finish with this isolate instead of failing the op
// sanitizer of whichever suite runs next.

/**
 * The real build and the cache agree: straight after the harness's own build
 * path runs, the cache says the assets on disk are up to date.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { staticAssetsAreUpToDate } from "#scripts/static-assets/cache.ts";
import { prepareStaticAssets } from "#scripts/static-assets/prepare.ts";

describe("the static asset cache after a real build", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  test("says yes right after the real build recorded itself", async () => {
    // The harness may skip its record when a source settled in the same
    // second the build began (see writeStaticAssetManifest). Preparing
    // again builds now, when every source has long settled, so a record
    // is certain.
    const build = await prepareStaticAssets({ quiet: true });
    try {
      expect(await staticAssetsAreUpToDate()).toBe(true);
    } finally {
      // A build that ran keeps esbuild's service process alive until it is
      // disposed.
      await build.dispose();
    }
  });
});
