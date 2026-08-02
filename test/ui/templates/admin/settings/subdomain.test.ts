import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { HostSubdomainForm } from "#templates/admin/settings/subdomain.tsx";
import { advancedDefaultState } from "#test/ui/templates/admin/settings-advanced/state.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

describe("HostSubdomainForm", () => {
  beforeAll(setupAdminPageTest);

  test("warns about Square webhook when provider is configured", () => {
    const html = String(
      HostSubdomainForm({
        ...advancedDefaultState,
        bunnyDnsEnabled: true,
        paymentProvider: "square",
      }),
    );
    expect(html).toContain("Changing your domain changes your payment webhook");
    expect(html).toContain('href="/admin/settings#settings-square-webhook"');
  });
});
