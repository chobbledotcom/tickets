import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { CustomDomainForm } from "#templates/admin/settings/custom-domain.tsx";
import { advancedDefaultState } from "#test/ui/templates/admin/settings-advanced/state.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

describe("CustomDomainForm", () => {
  beforeAll(setupAdminPageTest);

  test("shows the domain-change warning via lastActive when sales are off", () => {
    const html = String(
      CustomDomainForm({
        ...advancedDefaultState,
        bunnyCdnEnabled: true,
        lastActivePaymentProvider: "stripe",
        paymentProvider: null,
      }),
    );
    expect(html).toContain("Changing your domain changes your payment webhook");
    expect(html).toContain('href="/admin/settings#settings-stripe"');
  });

  test("hides the warning when no provider was ever configured", () => {
    const html = String(
      CustomDomainForm({
        ...advancedDefaultState,
        bunnyCdnEnabled: true,
        lastActivePaymentProvider: null,
        paymentProvider: null,
      }),
    );
    expect(html).not.toContain("Changing your domain");
  });

  test("renders all form fields, actions, and hints", () => {
    const html = String(
      CustomDomainForm({
        ...advancedDefaultState,
        bunnyCdnEnabled: true,
        bunnySubdomain: "my-sub",
        customDomain: "tickets.example.com",
        lastActivePaymentProvider: "stripe",
        paymentProvider: null,
      }),
    );
    // Form action + id
    expect(html).toContain('action="/admin/settings/custom-domain"');
    expect(html).toContain('id="settings-custom-domain"');
    // Input field
    expect(html).toContain('name="custom_domain"');
    expect(html).toContain('placeholder="tickets.yourdomain.com"');
    expect(html).toContain('type="text"');
    // Guide link
    expect(html).toContain('href="/admin/guide#custom-domain"');
    // Subdomain note (visible when subdomain is set)
    expect(html).toContain("same time as a custom domain");
    // Validate button (visible when customDomain is set)
    expect(html).toContain('action="/admin/settings/custom-domain/validate"');
    expect(html).toContain('id="settings-custom-domain-validate"');
    // DNS hint
    expect(html).toContain("DNS record is in place");
    // Payment name label
    expect(html).toContain("Name:");
  });
});
