/**
 * The door's map-backed storage, named the way localStorage names its
 * entries. The page falls back to it when the device blocks its own
 * storage, and the bundle suites drive it through the page; this suite
 * pins the store's own contract.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { mapStoreOver } from "#src/ui/client/scanner-door-store.ts";

describe("the door's map-backed storage", () => {
  test("the key past the end reads as absent, as localStorage names it", () => {
    const store = mapStoreOver(new Map([["a", "1"]]));
    expect(store.length).toBe(1);
    expect(store.key(0)).toBe("a");
    expect(store.key(1)).toBe(null);
    expect(store.getItem("gone")).toBe(null);

    store.setItem("b", "2");
    store.removeItem("a");
    expect(store.length).toBe(1);
    expect(store.key(0)).toBe("b");
  });
});
