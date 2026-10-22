/**
 * The offline suites' shared wiring: the saved-list wait's own contract.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { mapStoreOver } from "#src/ui/client/scanner-door-store.ts";
import { createGlobalStash } from "#test-utils/happy-dom.ts";
import { digestOf, HASHES_KEY, whenListIs } from "./offline-fixture.ts";

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

  test("a saved list that holds the digest reads as saved", async () => {
    const digest = await digestOf("TOK");
    const saved = JSON.stringify({ hashes: [digest], savedAt: 1 });
    const stash = createGlobalStash();
    stash.set("localStorage", mapStoreOver(new Map([[HASHES_KEY, saved]])));
    try {
      expect(await whenListIs(digest)).toBe(saved);
    } finally {
      stash.restore();
    }
  });
});
