/// <reference lib="dom" />
// test-groups: run-alone — the bundle runs inside happy-dom, whose internal
// task timers can outlive `happyDOM.abort()` under load; in a shared isolate
// a trailing timer fires during whichever suite runs next and fails its op
// sanitizer. Solo, it dies with the isolate — the proven-safe historical mode.

/**
 * The camera fakes' own refusals. A wait the page never satisfies names the
 * key it waited for, so a broken page fails its test at once.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { whenStoreHolds } from "./camera-fakes.ts";
import { useScannerSuite } from "./fixture.ts";

describe("scanner camera fakes", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

  test("says when the store never holds the key", async () => {
    const h = fresh();

    await expect(whenStoreHolds(h, "scanner-never")).rejects.toThrow(
      "The store never held scanner-never",
    );
  });
});
