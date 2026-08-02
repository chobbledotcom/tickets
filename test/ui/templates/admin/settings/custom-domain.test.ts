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

  test("hides the warning when no provider is configured (null or empty string)", () => {
    let html = String(
      CustomDomainForm({
        ...advancedDefaultState,
        bunnyCdnEnabled: true,
        lastActivePaymentProvider: null,
        paymentProvider: null,
      }),
    );
    expect(html).not.toContain("Changing your domain");
    expect(html).not.toContain(
      'action="/admin/settings/custom-domain/validate"',
    );
    // `"" ?? "stripe"` is "" but `"" || "stripe"` is "stripe" — distinguishes ?? from ||.
    html = String(
      CustomDomainForm({
        ...advancedDefaultState,
        bunnyCdnEnabled: true,
        lastActivePaymentProvider: "stripe",
        paymentProvider: "",
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
    // Prose container around the heading
    expect(html).toContain('class="prose"');
    // Whitespace between the intro sentence and the setup-guide anchor
    expect(html).toContain("your tickets site. <a");
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
    // Not-yet-validated warning (customDomainLastValidated defaults to "")
    expect(html).toContain("not yet validated");
    // DNS hint
    expect(html).toContain("DNS record is in place");
    // CNAME instructions: whitespace separators between strong tags and text
    expect(html).toContain("</strong> record:");
    expect(html).toContain("Name:</strong> <code");
    // Last-validated line is hidden when customDomainLastValidated is empty
    expect(html).not.toContain("Last validated:");
    // Payment name label
    expect(html).toContain("Name:");
  });
});
