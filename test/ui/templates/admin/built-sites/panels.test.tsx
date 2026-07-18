import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import { MaintenancePanel } from "#templates/admin/built-sites/panels.tsx";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import { testBuiltSite } from "#test-utils/factories.ts";
import {
  TEST_SCHEDULED_KEY,
  TEST_SCHEDULED_NEXT_KEY,
} from "#test-utils/scheduled.ts";

describe("built site maintenance panel", () => {
  beforeAll(async () => {
    setupTestEncryptionKey();
    await signCsrfToken();
  });

  test("offers provisioning when the site has no scheduled key", () => {
    const html = String(
      MaintenancePanel({
        site: testBuiltSite({ id: 42, scheduledTaskKey: null }),
      }),
    );

    expect(html).toContain("/admin/built-sites/42/provision-scheduler");
    expect(html).toContain("Set up scheduled maintenance");
    expect(html).not.toContain("stage-scheduler");
  });

  test("offers rotation when the site has an active key", () => {
    const html = String(
      MaintenancePanel({
        site: testBuiltSite({
          id: 42,
          scheduledTaskKey: TEST_SCHEDULED_KEY,
          scheduledTaskKeyNext: null,
        }),
      }),
    );

    expect(html).toContain(`<code>${TEST_SCHEDULED_KEY}</code>`);
    expect(html).toContain("/admin/built-sites/42/stage-scheduler");
    expect(html).toContain("Create and verify next key");
    expect(html).not.toContain("promote-scheduler");
  });

  test("offers verification and promotion for a pending key", () => {
    const html = String(
      MaintenancePanel({
        site: testBuiltSite({
          id: 42,
          scheduledTaskKey: TEST_SCHEDULED_KEY,
          scheduledTaskKeyNext: TEST_SCHEDULED_NEXT_KEY,
        }),
      }),
    );

    expect(html).toContain(`<code>${TEST_SCHEDULED_NEXT_KEY}</code>`);
    expect(html).toContain("Verify next key again");
    expect(html).toContain("/admin/built-sites/42/promote-scheduler");
    expect(html).toContain("Promote next key");
  });
});
