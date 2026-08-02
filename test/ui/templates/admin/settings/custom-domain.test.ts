import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { CustomDomainForm } from "#templates/admin/settings/custom-domain.tsx";
import { advancedDefaultState } from "#test/ui/templates/admin/settings-advanced/state.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

describe("CustomDomainForm", () => {
  beforeAll(setupAdminPageTest);

  test("warns about Stripe webhook when sales are off but provider remembered", () => {
    const html = String(
      CustomDomainForm({
        ...advancedDefaultState,
        bunnyCdnEnabled: true,
        paymentProvider: "stripe",
      }),
    );
    expect(html).toContain("Changing your domain changes your payment webhook");
    expect(html).toContain('href="/admin/settings#settings-stripe"');
  });
});
