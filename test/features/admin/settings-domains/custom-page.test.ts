import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import {
  advancedPageHtml,
  describeCustomDomain,
} from "#test/features/admin/settings-domains/support.ts";
import { withEnv } from "#test-utils/env.ts";
import { mockRequestWithHost } from "#test-utils/mocks.ts";
import { testCookie } from "#test-utils/session.ts";

describeCustomDomain("custom domain settings page", (enable) => {
  test("hides the custom domain form when Bunny CDN is not configured", async () => {
    assert(
      !(await advancedPageHtml()).includes('id="settings-custom-domain"'),
      "the value should not contain the searched item",
    );
  });

  test("shows the custom domain form when Bunny CDN is configured", async () => {
    enable();
    const html = await advancedPageHtml();
    assertStringIncludes(html, 'id="settings-custom-domain"');
    assertStringIncludes(html, "Custom domain");
  });

  test("leads with the host subdomain section, above the custom domain section", async () => {
    enable();
    using _env = withEnv({
      BUNNY_DNS_SUBDOMAIN_SUFFIX: ".tickets.test",
      BUNNY_DNS_ZONE_ID: "zone-id",
    });
    const html = await advancedPageHtml();
    assertStringIncludes(html, 'id="settings-host-subdomain"');
    expect(html.indexOf('id="settings-host-subdomain"')).toBeLessThan(
      html.indexOf('id="settings-custom-domain"'),
    );
  });

  test("hides validation when no custom domain is saved", async () => {
    enable();
    assert(
      !(await advancedPageHtml()).includes(
        'id="settings-custom-domain-validate"',
      ),
      "the value should not contain the searched item",
    );
  });

  test("shows validation instructions for a saved domain", async () => {
    enable();
    await settings.update.customDomain("tickets.example.com");
    const html = await advancedPageHtml();
    assertStringIncludes(html, 'id="settings-custom-domain-validate"');
    assertStringIncludes(html, "Make one CNAME record like this:");
    assertStringIncludes(
      html,
      "Open the DNS settings for your domain. These are often with the company you bought it from.",
    );
    assertStringIncludes(html, "CNAME");
    assertStringIncludes(html, "tickets.example.com");
    assertStringIncludes(html, "mysite.b-cdn.net");
    assertStringIncludes(html, "not yet validated");
    assertStringIncludes(html, "will not work until validation is complete");
  });

  test("shows the last validation time without the warning", async () => {
    enable();
    const cookie = await testCookie();
    const token = cookie.split("=").slice(1).join("=");
    await settings.update.customDomain("tickets.example.com");
    await settings.update.customDomainLastValidated();
    const response = await handleRequest(
      mockRequestWithHost("/admin/settings-advanced", "tickets.example.com", {
        headers: { cookie: `__Host-session=${token}` },
      }),
    );
    const html = await response.text();
    assertStringIncludes(html, "Last validated:");
    assert(
      !html.includes("not yet validated"),
      "the value should not contain the searched item",
    );
  });
});
