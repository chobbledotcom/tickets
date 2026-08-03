import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { HostSubdomainForm } from "#templates/admin/settings/subdomain.tsx";
import { advancedDefaultState } from "#test/ui/templates/admin/settings-advanced/state.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

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
    expect(html).toContain("Changing your domain changes your payment webhook");
    expect(html).toContain('href="/admin/settings#settings-square-webhook"');
  });

  test("hides the domain-change warning when no provider is configured", () => {
    const html = String(
      HostSubdomainForm({
        ...advancedDefaultState,
        bunnyDnsEnabled: true,
        existingPaymentProvider: null,
      }),
    );
    expect(html).not.toContain("Changing your domain");
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
    expect(html).not.toContain("Changing your domain");
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
    expect(html).toContain("my-sub.example.com");
    expect(html).toContain("is available");
    // Whitespace between the previewed domain and the "is available" suffix
    expect(html).toContain("</strong> is available");
    const form = html.match(
      /<form[^>]*action="\/admin\/settings\/host-subdomain"[^>]*>[\s\S]*?<\/form>/,
    )?.[0];
    const subdomainInput = form?.match(
      /<input[^>]*name="subdomain"[^>]*>/,
    )?.[0];
    expect(subdomainInput).toContain('type="hidden"');
    expect(subdomainInput).toContain('value="my-sub"');
    expect(html).toContain("Confirm registration");
    // Confirm checkbox: defaults to unchecked, carries name="save" + value="1"
    expect(html).not.toContain("checked");
    expect(html).toContain('name="save"');
    expect(html).toContain('value="1"');
    expect(html).toContain("Register Subdomain");
    expect(html).toContain("btn secondary");
    expect(html).toContain("Cancel");
    expect(html).toContain(
      'href="/admin/settings-advanced#settings-host-subdomain"',
    );
    expect(form).toContain('id="settings-host-subdomain"');
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
    )?.[0];
    const subdomainInput = form?.match(
      /<input[^>]*autocomplete="off"[^>]*name="subdomain"[^>]*>/,
    )?.[0];
    expect(subdomainInput).toContain('type="text"');
    expect(form).toContain('id="settings-host-subdomain"');
    expect(form).toContain("Check");
    expect(html).toContain("muted");
    expect(html).toContain(".tickets.example");
  });

  test("renders the active subdomain state", () => {
    const html = String(
      HostSubdomainForm({
        ...advancedDefaultState,
        bunnyDnsEnabled: true,
        bunnySubdomain: "my-sub",
      }),
    );
    expect(html).toContain("Your site is available at");
    expect(html).toContain("at <a");
    expect(html).toContain("https://my-sub");
    expect(html).toContain("can also set a custom domain");
    expect(html).toContain("permanent and cannot be changed");
  });
});
