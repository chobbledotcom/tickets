import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import { adminSettingsPage } from "#templates/admin/settings.tsx";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import {
  defaultSettingsState,
  TEST_SETTINGS_SESSION,
} from "./settings-state.ts";

describe("admin settings page", () => {
  beforeAll(async () => {
    setupTestEncryptionKey();
    await signCsrfToken();
  });

  test("renders its page shell and core forms", () => {
    const html = adminSettingsPage(
      TEST_SETTINGS_SESSION,
      defaultSettingsState(),
    );

    expect(html).toContain("<title>Settings");
    expect(html).toContain('id="settings-business-email"');
    expect(html).toContain('id="settings-payment-provider"');
  });
});
