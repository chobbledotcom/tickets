import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { CustomDomainForm } from "#templates/admin/settings/custom-domain.tsx";
import { advancedDefaultState } from "#test/ui/templates/admin/settings-advanced/state.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

describe("CustomDomainForm", () => {
  beforeAll(setupAdminPageTest);

  test("shows the domain-change warning when sales are off", () => {
    const html = String(
      CustomDomainForm({
        ...advancedDefaultState,
        bunnyCdnEnabled: true,
        existingPaymentProvider: "stripe",
      }),
    );
    expect(html).toContain("Changing your domain changes your payment webhook");
    expect(html).toContain('href="/admin/settings#settings-stripe"');
  });

  test("hides the warning when no provider is configured", () => {
    const html = String(
      CustomDomainForm({
        ...advancedDefaultState,
        bunnyCdnEnabled: true,
        existingPaymentProvider: null,
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
        existingPaymentProvider: "stripe",
      }),
    );
    const form = html.match(
      /<form[^>]*action="\/admin\/settings\/custom-domain"[^>]*>[\s\S]*?<\/form>/,
    );
    expect(form).not.toBeNull();
    if (form === null) return;
    const formHtml = form[0];
    expect(formHtml).toContain('id="settings-custom-domain"');
    // Prose container around the heading
    expect(html).toContain('class="prose"');
    // Whitespace between the example URL and the setup-guide anchor
    expect(html).toContain("<code>tickets.example.co.uk</code>. <a");
    const domainInput = formHtml.match(/<input[^>]*name="custom_domain"[^>]*>/);
    expect(domainInput).not.toBeNull();
    if (domainInput === null) return;
    expect(domainInput[0]).toContain('placeholder="tickets.example.co.uk"');
    expect(domainInput[0]).toContain('type="text"');
    expect(domainInput[0]).toContain('value="tickets.example.com"');
    // Guide link
    expect(html).toContain('href="/admin/guide#custom-domain"');
    // Subdomain note (visible when subdomain is set)
    expect(html).toContain("keeps working at the same time");
    // Validate button (visible when customDomain is set)
    expect(html).toContain('action="/admin/settings/custom-domain/validate"');
    expect(html).toContain('id="settings-custom-domain-validate"');
    // Not-yet-validated warning (customDomainLastValidated defaults to "")
    expect(html).toContain("not yet validated");
    // Numbered CNAME steps with the record values
    expect(html).toContain("Make one CNAME record like this:");
    expect(html).toContain(
      "Open the DNS settings where you bought your domain.",
    );
    expect(html).toContain("Validation can take a few minutes.");
    // CNAME record rows: whitespace separators between strong tags and text
    expect(html).toContain("Name:</strong> <code");
    expect(html).toContain("TTL:</strong> 3600");
    // Last-validated line is hidden when customDomainLastValidated is empty
    expect(html).not.toContain("Last validated:");
  });

  test("blocks a domain change until provider recovery is complete", () => {
    const html = String(
      CustomDomainForm({
        ...advancedDefaultState,
        bunnyCdnEnabled: true,
        paymentProviderRecoveryNeeded: true,
      }),
    );
    expect(html).toContain('<button disabled type="submit">');
    expect(html).toContain("Choose the provider for existing payments");
  });
});
