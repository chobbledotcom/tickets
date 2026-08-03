import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import {
  advancedPageHtml,
  describeCustomDomain,
} from "#test/features/admin/settings-domains/support.ts";
import { mockRequestWithHost } from "#test-utils/mocks.ts";
import { testCookie } from "#test-utils/session.ts";

describeCustomDomain("custom domain settings page", (enable) => {
  test("hides the custom domain form when Bunny CDN is not configured", async () => {
    expect(await advancedPageHtml()).not.toContain(
      'id="settings-custom-domain"',
    );
  });

  test("shows the custom domain form when Bunny CDN is configured", async () => {
    enable();
    const html = await advancedPageHtml();
    expect(html).toContain('id="settings-custom-domain"');
    expect(html).toContain("Custom Domain");
  });

  test("hides validation when no custom domain is saved", async () => {
    enable();
    expect(await advancedPageHtml()).not.toContain(
      'id="settings-custom-domain-validate"',
    );
  });

  test("shows validation instructions for a saved domain", async () => {
    enable();
    await settings.update.customDomain("tickets.example.com");
    const html = await advancedPageHtml();
    expect(html).toContain('id="settings-custom-domain-validate"');
    expect(html).toContain("CNAME");
    expect(html).toContain("tickets.example.com");
    expect(html).toContain("mysite.b-cdn.net");
    expect(html).toContain("not yet validated");
    expect(html).toContain("will not work until validation is complete");
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
    expect(html).toContain("Last validated:");
    expect(html).not.toContain("not yet validated");
  });
});
