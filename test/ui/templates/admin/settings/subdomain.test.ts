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

  test("hides the domain-change warning when no provider is configured (null or empty string)", () => {
    let html = String(
      HostSubdomainForm({
        ...advancedDefaultState,
        bunnyDnsEnabled: true,
        lastActivePaymentProvider: null,
        paymentProvider: null,
      }),
    );
    expect(html).not.toContain("Changing your domain");
    // `paymentProvider ?? lastActive` resolves to "" (not "square") under `??`;
    // a `||` mutant would fall through to "square" and show the warning.
    html = String(
      HostSubdomainForm({
        ...advancedDefaultState,
        bunnyDnsEnabled: true,
        lastActivePaymentProvider: "square",
        paymentProvider: "",
      }),
    );
    expect(html).not.toContain("Changing your domain");
    // Same `??` on the subdomain-preview branch (line 48) — rendered when a
    // preview is set rather than the check form.
    html = String(
      HostSubdomainForm({
        ...advancedDefaultState,
        bunnyDnsEnabled: true,
        lastActivePaymentProvider: "square",
        paymentProvider: "",
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
        lastActivePaymentProvider: "square",
        paymentProvider: null,
        subdomainPreview: "my-sub",
        subdomainPreviewFullDomain: "my-sub.example.com",
      }),
    );
    expect(html).toContain("my-sub.example.com");
    expect(html).toContain("is available");
    // Whitespace between the previewed domain and the "is available" suffix
    expect(html).toContain("</strong> is available");
    // Hidden input: CsrfForm also renders a hidden csrf_token input, so pin
    // the subdomain input's hidden type via a regex over its own attributes.
    expect(html).toMatch(/<input[^>]*name="subdomain"[^>]*type="hidden"/);
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
    expect(html).toMatch(/<input[^>]*autocomplete="off"[^>]*name="subdomain"/);
    expect(html).toContain("muted");
    expect(html).toContain(".tickets.example");
    expect(html).toContain("Check");
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
