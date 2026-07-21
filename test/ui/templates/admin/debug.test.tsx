import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { adminDebugPage } from "#templates/admin/debug.tsx";
import { debugOwnerSession, makeDebugState } from "#test-utils/debug.ts";

describe("admin debug template", () => {
  test("does not render retired request-based pruning state", () => {
    const html = adminDebugPage(debugOwnerSession, makeDebugState());

    expect(html).not.toContain("Database pruning");
    expect(html).not.toContain("PRUNE_INTERVAL_HOURS");
    expect(html).not.toContain("Last pruned (UTC)");
  });
});
