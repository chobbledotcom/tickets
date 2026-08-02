import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { HostSubdomainForm } from "#templates/admin/settings/subdomain.tsx";
import { advancedDefaultState } from "#test/ui/templates/admin/settings-advanced/state.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

describe("HostSubdomainForm", () => {
  beforeAll(setupAdminPageTest);

  test("shows the domain-change warning via lastActive when sales are off", () => {
    const html = String(
      HostSubdomainForm({
        ...advancedDefaultState,
        bunnyDnsEnabled: true,
        lastActivePaymentProvider: "square",
        paymentProvider: null,
      }),
    );
    expect(html).toContain("Changing your domain changes your payment webhook");
    expect(html).toContain('href="/admin/settings#settings-square-webhook"');
  });

  test("hides the warning when no provider was ever configured", () => {
    const html = String(
      HostSubdomainForm({
        ...advancedDefaultState,
        bunnyDnsEnabled: true,
        lastActivePaymentProvider: null,
        paymentProvider: null,
      }),
    );
    expect(html).not.toContain("Changing your domain");
  });

  test("renders the register form when a subdomain is available", () => {
    const html = String(
      HostSubdomainForm({
        ...advancedDefaultState,
        bunnyDnsEnabled: true,
        lastActivePaymentProvider: "square",
        paymentProvider: null,
        subdomainPreview: "my-sub",
        subdomainPreviewFullDomain: "my-sub.example.com",
      }),
    );
    // Full domain preview
    expect(html).toContain("my-sub.example.com");
    expect(html).toContain("is available");
    // Hidden input
    expect(html).toContain('name="subdomain"');
    expect(html).toContain('type="hidden"');
    // Confirm label
    expect(html).toContain("Confirm registration");
    // Register button
    expect(html).toContain("Register Subdomain");
    // Cancel link
    expect(html).toContain("Cancel");
    expect(html).toContain(
      'href="/admin/settings-advanced#settings-host-subdomain"',
    );
    // First form
    expect(html).toContain('action="/admin/settings/host-subdomain"');
    expect(html).toContain('id="settings-host-subdomain"');
  });

  test("renders the check form when no subdomain is set", () => {
    const html = String(
      HostSubdomainForm({
        ...advancedDefaultState,
        bunnyDnsEnabled: true,
        bunnyDnsSubdomainSuffix: ".tickets.example",
        lastActivePaymentProvider: null,
        paymentProvider: null,
      }),
    );
    expect(html).toContain('type="text"');
    expect(html).toContain("muted");
    expect(html).toContain(".tickets.example");
    expect(html).toContain("Check");
  });
});
