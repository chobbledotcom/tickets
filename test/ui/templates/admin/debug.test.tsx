import { assert } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { adminDebugPage } from "#templates/admin/debug.tsx";
import { debugOwnerSession, makeDebugState } from "#test-utils/debug.ts";

describe("admin debug template", () => {
  test("does not render retired request-based pruning state", () => {
    const html = adminDebugPage(debugOwnerSession, makeDebugState());

    assert(
      !html.includes("Database pruning"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("PRUNE_INTERVAL_HOURS"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("Last pruned (UTC)"),
      "the value should not contain the searched item",
    );
  });
});
