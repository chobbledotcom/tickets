import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { HostSubdomainForm } from "#templates/admin/settings/subdomain.tsx";
import { advancedDefaultState } from "#test/ui/templates/admin/settings-advanced/state.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { says } from "#test-utils/says.ts";

describe("HostSubdomainForm", () => {
  beforeAll(setupAdminPageTest);

  test("shows the domain-change warning when sales are off", () => {
    const html = String(
      HostSubdomainForm({
        ...advancedDefaultState,
        bunnyDnsEnabled: true,
        existingPaymentProvider: "square",
      }),
    );
    says(html, "Changing your domain changes your payment webhook");
    says(html, 'href="/admin/settings#settings-square-webhook"');
  });

  test("hides the domain-change warning when no provider is configured", () => {
    const html = String(
      HostSubdomainForm({
        ...advancedDefaultState,
        bunnyDnsEnabled: true,
        existingPaymentProvider: null,
      }),
    );
    assert(!html.includes("Changing your domain"));
  });

  test("hides the warning on the preview when no provider is configured", () => {
    const html = String(
      HostSubdomainForm({
        ...advancedDefaultState,
        bunnyDnsEnabled: true,
        existingPaymentProvider: null,
        subdomainPreview: "preview",
        subdomainPreviewFullDomain: "preview.example",
      }),
    );
    assert(!html.includes("Changing your domain"));
  });

  test("renders the register form when a subdomain is available", () => {
    const html = String(
      HostSubdomainForm({
        ...advancedDefaultState,
        bunnyDnsEnabled: true,
        existingPaymentProvider: "square",
        subdomainPreview: "my-sub",
        subdomainPreviewFullDomain: "my-sub.example.com",
      }),
    );
    says(html, "my-sub.example.com");
    says(html, "is free");
    // Whitespace between the previewed domain and the "is free" suffix
    says(html, "</strong> is free.");
    const form = html.match(
      /<form[^>]*action="\/admin\/settings\/host-subdomain"[^>]*>[\s\S]*?<\/form>/,
    );
    expect(form).not.toBeNull();
    if (form === null) return;
    const subdomainInput = form[0].match(/<input[^>]*name="subdomain"[^>]*>/);
    expect(subdomainInput).not.toBeNull();
    if (subdomainInput === null) return;
    says(subdomainInput[0], 'type="hidden"');
    says(subdomainInput[0], 'value="my-sub"');
    says(html, "Register this subdomain. This cannot be undone.");
    // Confirm checkbox: defaults to unchecked, carries name="save" + value="1"
    assert(!html.includes("checked"));
    says(html, 'name="save"');
    says(html, 'value="1"');
    says(html, "Register subdomain");
    says(html, "btn secondary");
    says(html, "Cancel");
    says(html, 'href="/admin/settings-advanced#settings-host-subdomain"');
    says(form[0], 'id="settings-host-subdomain"');
  });

  test("renders the check form when no subdomain is set", () => {
    const html = String(
      HostSubdomainForm({
        ...advancedDefaultState,
        bunnyDnsEnabled: true,
        bunnyDnsSubdomainSuffix: ".tickets.example",
        existingPaymentProvider: null,
      }),
    );
    const form = html.match(
      /<form[^>]*action="\/admin\/settings\/host-subdomain"[^>]*>[\s\S]*?<\/form>/,
    );
    expect(form).not.toBeNull();
    if (form === null) return;
    const subdomainInput = form[0].match(
      /<input[^>]*autocomplete="off"[^>]*name="subdomain"[^>]*>/,
    );
    expect(subdomainInput).not.toBeNull();
    if (subdomainInput === null) return;
    says(subdomainInput[0], 'type="text"');
    says(form[0], 'id="settings-host-subdomain"');
    says(form[0], "Check if the name is free");
    says(html, "muted");
    says(html, ".tickets.example");
    // The intro promises the address through the check, not an example that
    // would need the DNS zone to be exact.
    says(html, "Press Check if the name is free to see your full site address");
  });

  test("renders the active subdomain state", () => {
    const html = String(
      HostSubdomainForm({
        ...advancedDefaultState,
        bunnyDnsEnabled: true,
        bunnySubdomain: "my-sub",
      }),
    );
    says(html, "Your site is available at");
    says(html, "at <a");
    says(html, "https://my-sub");
    says(html, "can also set a custom domain");
    says(html, "permanent and cannot be changed");
  });
});
