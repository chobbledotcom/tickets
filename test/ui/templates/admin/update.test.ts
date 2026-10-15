import { assert } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { GITHUB_RELEASES_URL } from "#shared/update.ts";
import {
  adminUpdatePage,
  type UpdatePageState,
} from "#templates/admin/update.tsx";
import { OWNER_SESSION } from "#test-utils/admin-page-test.ts";
import { says } from "#test-utils/says.ts";

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
    const html = adminUpdatePage(OWNER_SESSION, state);
    says(html, "abc123def456");
    says(html, "<code>");
  });

  test("hides commit section when buildCommit is empty", () => {
    const html = adminUpdatePage(OWNER_SESSION, baseState());
    assert(!html.includes("<code>"));
  });

  test("renders update available with Bunny configured", () => {
    const state = {
      ...baseState(),
      latestVersion: "v2099-01-01-120000",
      latestVersionName: "2099-01-01 - Update",
      providerConfigured: true,
      updateAvailable: true,
    };
    const html = adminUpdatePage(OWNER_SESSION, state);
    says(html, "Update Now");
    assert(!html.includes("Cannot update automatically"));
  });

  test("renders cannot update when Bunny not configured", () => {
    const state = {
      ...baseState(),
      latestVersion: "v2099-01-01-120000",
      latestVersionName: "2099-01-01 - Update",
      providerConfigured: false,
      updateAvailable: true,
    };
    const html = adminUpdatePage(OWNER_SESSION, state);
    says(html, "Cannot update automatically");
    assert(!html.includes("Update Now"));
  });

  test("renders up to date with checked version", () => {
    const state = {
      ...baseState(),
      latestVersion: "v2026-01-01-000000",
    };
    const html = adminUpdatePage(OWNER_SESSION, state);
    says(html, "No Update Available");
    says(html, "v2026-01-01-000000");
  });

  test("does not show update sections when no check performed", () => {
    const html = adminUpdatePage(OWNER_SESSION, baseState());
    assert(!html.includes("No Update Available"));
    assert(!html.includes("Update Available"));
  });

  test("includes release notes link", () => {
    const html = adminUpdatePage(OWNER_SESSION, baseState());
    says(html, `<a href="${GITHUB_RELEASES_URL}">Read the release notes</a>`);
  });
});
