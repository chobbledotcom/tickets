import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { AdminSession } from "#lib/types.ts";
import {
  adminUpdatePage,
  type UpdatePageState,
} from "#templates/admin/update.tsx";

const SESSION: AdminSession = {
  adminLevel: "owner",
};

const baseState = (): UpdatePageState => ({
  buildDate: "Thu, 28 Mar 2026 14:30:22 UTC",
  buildCommit: "",
  latestVersion: "",
  latestVersionName: "",
  updateAvailable: false,
  bunnyConfigured: false,
});

describe("adminUpdatePage", () => {
  test("renders build commit when present", () => {
    const state = { ...baseState(), buildCommit: "abc123def456" };
    const html = adminUpdatePage(SESSION, state);
    expect(html).toContain("abc123def456");
    expect(html).toContain("<code>");
  });

  test("hides commit section when buildCommit is empty", () => {
    const html = adminUpdatePage(SESSION, baseState());
    expect(html).not.toContain("<code>");
  });

  test("renders update available with Bunny configured", () => {
    const state = {
      ...baseState(),
      latestVersion: "v2099-01-01-120000",
      latestVersionName: "2099-01-01 - Update",
      updateAvailable: true,
      bunnyConfigured: true,
    };
    const html = adminUpdatePage(SESSION, state);
    expect(html).toContain("Update Now");
    expect(html).not.toContain("Cannot update automatically");
  });

  test("renders up to date with checked version", () => {
    const state = {
      ...baseState(),
      latestVersion: "v2026-01-01-000000",
    };
    const html = adminUpdatePage(SESSION, state);
    expect(html).toContain("No Update Available");
    expect(html).toContain("v2026-01-01-000000");
  });

  test("does not show update sections when no check performed", () => {
    const html = adminUpdatePage(SESSION, baseState());
    expect(html).not.toContain("No Update Available");
    expect(html).not.toContain("Update Available");
  });
});
