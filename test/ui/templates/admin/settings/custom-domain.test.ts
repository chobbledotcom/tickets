import { assert, assertStringIncludes } from "@std/assert";
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
    assertStringIncludes(
      html,
      "Changing your domain changes your payment webhook",
    );
    assertStringIncludes(html, 'href="/admin/settings#settings-stripe"');
  });

  test("hides the warning when no provider is configured", () => {
    const html = String(
      CustomDomainForm({
        ...advancedDefaultState,
        bunnyCdnEnabled: true,
        existingPaymentProvider: null,
      }),
    );
    assert(
      !html.includes("Changing your domain"),
      "the value should not contain the searched item",
    );
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
    assertStringIncludes(html, 'class="prose"');
    // The intro links the guide's buy-a-domain steps
    assertStringIncludes(
      html,
      'The <a href="/admin/guide#custom-domain">setup guide</a> shows you how to point it here',
    );
    const domainInput = formHtml.match(/<input[^>]*name="custom_domain"[^>]*>/);
    expect(domainInput).not.toBeNull();
    if (domainInput === null) return;
    assertStringIncludes(domainInput[0], 'placeholder="tickets.example.co.uk"');
    assertStringIncludes(domainInput[0], 'type="text"');
    assertStringIncludes(domainInput[0], 'value="tickets.example.com"');
    // Guide link
    assertStringIncludes(html, 'href="/admin/guide#custom-domain"');
    // Subdomain note (visible when subdomain is set)
    assertStringIncludes(html, "keeps working at the same time");
    // Validate button (visible when customDomain is set)
    assertStringIncludes(
      html,
      'action="/admin/settings/custom-domain/validate"',
    );
    assertStringIncludes(html, 'id="settings-custom-domain-validate"');
    // Not-yet-validated warning (customDomainLastValidated defaults to "")
    assertStringIncludes(html, "not yet validated");
    // Numbered CNAME steps with the record values
    assertStringIncludes(html, "Make one CNAME record like this:");
    assertStringIncludes(html, "Open the DNS settings for your domain.");
    assertStringIncludes(html, "Validation can take a few minutes.");
    // CNAME record rows: the exact label, value, and one space between them
    assertStringIncludes(html, "<strong>Type:</strong> CNAME");
    assertStringIncludes(
      html,
      "<strong>Name:</strong> <code>tickets.example.com</code>",
    );
    assertStringIncludes(html, "<strong>TTL:</strong> 3600");
    // Last-validated line is hidden when customDomainLastValidated is empty
    assert(
      !html.includes("Last validated"),
      "the value should not contain the searched item",
    );
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
    assertStringIncludes(
      html,
      "<strong>Value:</strong> <code>site.b-cdn.net</code>",
    );
    assertStringIncludes(html, "Last validated: 2026-09-24T17:26:00.000Z");
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
