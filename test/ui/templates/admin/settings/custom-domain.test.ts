import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { CustomDomainForm } from "#templates/admin/settings/custom-domain.tsx";
import { advancedDefaultState } from "#test/ui/templates/admin/settings-advanced/state.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";

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
    expectIncludesAll(html, [
      "Changing your domain changes your payment webhook",
      'href="/admin/settings#settings-stripe"',
    ]);
  });

  test("hides the warning when no provider is configured", () => {
    const html = String(
      CustomDomainForm({
        ...advancedDefaultState,
        bunnyCdnEnabled: true,
        existingPaymentProvider: null,
      }),
    );
    assert(!html.includes("Changing your domain"));
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
    assertStringIncludes(formHtml, 'id="settings-custom-domain"');
    // Prose container around the heading
    expectIncludesAll(html, [
      'class="prose"',
      // The intro links the guide's buy-a-domain steps
      'The <a href="/admin/guide#custom-domain">setup guide</a> shows you how to point it here',
    ]);
    const domainInput = formHtml.match(/<input[^>]*name="custom_domain"[^>]*>/);
    expect(domainInput).not.toBeNull();
    if (domainInput === null) return;
    assertStringIncludes(
      domainInput[0] ?? "",
      'placeholder="tickets.example.co.uk"',
    );
    assertStringIncludes(domainInput[0] ?? "", 'type="text"');
    assertStringIncludes(domainInput[0] ?? "", 'value="tickets.example.com"');
    // Guide link
    expectIncludesAll(html, [
      'href="/admin/guide#custom-domain"',
      // Subdomain note (visible when subdomain is set)
      "keeps working at the same time",
      // Validate button (visible when customDomain is set)
      'action="/admin/settings/custom-domain/validate"',
      'id="settings-custom-domain-validate"',
      // Not-yet-validated warning (customDomainLastValidated defaults to "")
      "not yet validated",
      // Numbered CNAME steps with the record values
      "Make one CNAME record like this:",
      "Open the DNS settings for your domain.",
      "Validation can take a few minutes.",
      // CNAME record rows: the exact label, value, and one space between them
      "<strong>Type:</strong> CNAME",
      "<strong>Name:</strong> <code>tickets.example.com</code>",
      "<strong>TTL:</strong> 3600",
    ]);
    // Last-validated line is hidden when customDomainLastValidated is empty
    assert(!html.includes("Last validated"));
  });

  test("shows the last validation time beside its label", () => {
    const html = String(
      CustomDomainForm({
        ...advancedDefaultState,
        bunnyCdnEnabled: true,
        cdnHostname: "site.b-cdn.net",
        customDomain: "tickets.example.com",
        customDomainLastValidated: "2026-09-24T17:26:00.000Z",
      }),
    );
    expectIncludesAll(html, [
      "<strong>Value:</strong> <code>site.b-cdn.net</code>",
      "Last validated: 2026-09-24T17:26:00.000Z",
    ]);
  });

  test("blocks a domain change until provider recovery is complete", () => {
    const html = String(
      CustomDomainForm({
        ...advancedDefaultState,
        bunnyCdnEnabled: true,
        customDomain: "tickets.example.com",
        paymentProviderRecoveryNeeded: true,
      }),
    );
    // Both the save and the validate submit buttons are disabled, the same
    // way the host-subdomain register button is.
    expect(html.match(/<button disabled type="submit">/g)?.length).toBe(2);
    assertStringIncludes(html, "Choose the provider for existing payments");
  });
});
