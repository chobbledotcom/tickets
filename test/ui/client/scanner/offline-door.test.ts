/// <reference lib="dom" />
// test-groups: run-alone — the page loads the built bundle inside happy-dom,
// whose internal task timers can outlive `happyDOM.abort()` under load; in a
// shared isolate a trailing timer fires during whichever suite runs next and
// fails its op sanitizer. Solo, it dies with the isolate.

/**
 * The offline door's shared helpers' own behaviors. A panel with no rows
 * names the page, so a broken test fails at once.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { useScannerSuite } from "./fixture.ts";
import { firstRow } from "./offline-door.ts";

describe("scanner offline door helpers", {
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  const fresh = useScannerSuite();

  test("names the page when the panel carries no rows", () => {
    const h = fresh();

    expect(() => firstRow(h)).toThrow("The queue panel carries no first row");
  });
});
