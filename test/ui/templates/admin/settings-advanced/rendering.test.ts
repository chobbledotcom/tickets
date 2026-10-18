import { assert, assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  type AdvancedSettingsPageState,
  adminAdvancedSettingsPage,
} from "#templates/admin/settings-advanced.tsx";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import { advancedDefaultState } from "./state.ts";

describe("admin advanced settings rendering contracts", () => {
  beforeAll(async () => {
    setupTestEncryptionKey();
    await signCsrfToken();
  });

  const render = (updates: Partial<AdvancedSettingsPageState> = {}): string =>
    adminAdvancedSettingsPage(
      { adminLevel: "owner" },
      { ...advancedDefaultState, ...updates },
    );

  test("marks the advanced settings route as active", () => {
    assertStringIncludes(
      render(),
      '<a class="active" href="/admin/settings-advanced">',
    );
  });

  test("renders the scheduled maintenance section with its prose class", () => {
    assertStringIncludes(
      render(),
      '<article class="prose"><h2>Scheduled maintenance</h2>',
    );
  });

  test("shows the configured scheduled maintenance key as code", () => {
    const html = render({ scheduledTaskKey: "scheduled-secret" });

    assertStringIncludes(html, "<code>scheduled-secret</code>");
    assert(!html.includes("No scheduled maintenance key is set on this site."));
  });

  test("shows the unset message when no scheduled maintenance key exists", () => {
    const html = render();

    assertStringIncludes(
      html,
      "No scheduled maintenance key is set on this site.",
    );
  });

  test("renders the reset form with its exact action and id", () => {
    const html = render();

    assertStringIncludes(html, 'action="/admin/settings/reset-database"');
    assertStringIncludes(html, 'id="settings-reset-database"');
  });
});
