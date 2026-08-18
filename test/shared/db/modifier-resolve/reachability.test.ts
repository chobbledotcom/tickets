import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  reachablePageIds,
  scopeIsChildDeadEnd,
} from "#shared/db/modifier-resolve.ts";

/**
 * The two pure rules behind the child-only add-on block. An add-on dead-ends
 * when every page that offers it belongs to a child listing with no page of
 * its own. Both rules are plain data in, plain answer out, so they are tested
 * here rather than through a saved listing.
 */

describe("scopeIsChildDeadEnd", () => {
  test("a whole-order add-on is never a dead end", () => {
    // A null scope means the add-on loads on every page, so no listing choice
    // takes it away.
    expect(scopeIsChildDeadEnd(null, new Set([5]), new Set())).toBe(false);
  });

  test("a scope that names no hidden child is never a dead end", () => {
    // Listing 5 keeps its own page. The add-on stays reachable there, whatever
    // the parent pages hold.
    expect(scopeIsChildDeadEnd([5], new Set([9]), new Set())).toBe(false);
  });

  test("a scope of one hidden child with no page left is a dead end", () => {
    expect(scopeIsChildDeadEnd([5], new Set([5]), new Set())).toBe(true);
  });

  test("one live page in the scope rescues the hidden child", () => {
    expect(scopeIsChildDeadEnd([5, 6], new Set([5]), new Set([6]))).toBe(false);
  });
});

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
