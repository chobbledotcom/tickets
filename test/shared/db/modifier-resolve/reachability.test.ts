import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { reachablePageIds } from "#db/modifier-resolve.ts";

/**
 * The pure rule behind which listings still serve a booking page that can
 * offer an add-on. Plain data in, plain answer out, so it is tested here
 * rather than through a saved listing. (The dead-end test over scopes moved
 * with it to `test/shared/listing-parents-rules.test.ts`.)
 */

describe("reachablePageIds", () => {
  test("keeps a listing that is live and is not a hidden child", () => {
    const pages = reachablePageIds([{ active: true, id: 1 }], new Set());
    expect([...pages]).toEqual([1]);
  });

  test("drops a listing that is switched off", () => {
    // An inactive listing serves no public page, so it cannot carry an add-on
    // even though nothing hides it.
    const pages = reachablePageIds([{ active: false, id: 1 }], new Set());
    expect([...pages]).toEqual([]);
  });

  test("drops a live listing that is a hidden child", () => {
    const pages = reachablePageIds([{ active: true, id: 1 }], new Set([1]));
    expect([...pages]).toEqual([]);
  });

  test("keeps only the pages that pass both rules", () => {
    const pages = reachablePageIds(
      [
        { active: true, id: 1 },
        { active: false, id: 2 },
        { active: true, id: 3 },
        { active: false, id: 4 },
      ],
      new Set([3, 4]),
    );
    expect([...pages]).toEqual([1]);
  });
});
