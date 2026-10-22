/**
 * The offline suites' shared wiring: the saved-list wait's own contract.
 * The bundle journeys around it live in `scanner-offline.test.ts` and
 * `scanner-offline/sync.test.ts`.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { mapStoreOver } from "#src/ui/client/scanner-door-store.ts";
import { createGlobalStash } from "#test-utils/happy-dom.ts";
import { digestOf, whenListIs } from "./offline-fixture.ts";

describe("the saved-list wait", () => {
  test("a digest that never lands reads as absent", async () => {
    const stash = createGlobalStash();
    stash.set("localStorage", mapStoreOver(new Map([["other", "kept"]])));
    try {
      expect(await whenListIs(await digestOf("ZZZZ"))).toBe("");
    } finally {
      stash.restore();
    }
  });
});
