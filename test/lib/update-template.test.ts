import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { AdminSession } from "#shared/types.ts";
import { GITHUB_RELEASES_URL } from "#shared/update.ts";
import {
  adminUpdatePage,
  type UpdatePageState,
} from "#templates/admin/update.tsx";

const SESSION: AdminSession = {
  adminLevel: "owner",
};

const baseState = (): UpdatePageState => ({
  buildCommit: "",
  buildDate: "Thu, 28 Mar 2026 14:30:22 UTC",
  latestVersion: "",
  latestVersionName: "",
  providerConfigured: false,
  updateAvailable: false,
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
      providerConfigured: true,
      updateAvailable: true,
    };
    const html = adminUpdatePage(SESSION, state);
    expect(html).toContain("Update Now");
    expect(html).not.toContain("Cannot update automatically");
  });

  test("renders cannot update when Bunny not configured", () => {
    const state = {
      ...baseState(),
      latestVersion: "v2099-01-01-120000",
      latestVersionName: "2099-01-01 - Update",
      providerConfigured: false,
      updateAvailable: true,
    };
    const html = adminUpdatePage(SESSION, state);
    expect(html).toContain("Cannot update automatically");
    expect(html).not.toContain("Update Now");
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

  test("includes release notes link", () => {
    const html = adminUpdatePage(SESSION, baseState());
    expect(html).toContain(GITHUB_RELEASES_URL);
    expect(html).toContain("release notes");
  });
});
