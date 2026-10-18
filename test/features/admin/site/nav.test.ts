import { assert, assertStringIncludes } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { adminGet, testCookie } from "#test-utils/session.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

describeWithEnv("server (admin site nav)", { db: true }, () => {
  describe("site subnav", () => {
    /** Fetch a site admin page and assert it contains subnav links */
    const expectSubnav = async (path: string) => {
      await enablePublicSite();
      const response = await awaitTestRequest(path, {
        cookie: await testCookie(),
      });
      const html = await response.text();
      assertStringIncludes(html, 'href="/admin/site"');
      assertStringIncludes(html, 'href="/admin/site/contact"');
      assertStringIncludes(html, 'href="/admin/site/order"');
      assertStringIncludes(html, "Homepage");
      assertStringIncludes(html, "Contact");
      assertStringIncludes(html, "Order");
    };

    test("homepage shows subnav with Homepage, Contact and Order links", async () => {
      await expectSubnav("/admin/site");
    });

    test("contact page shows subnav with Homepage, Contact and Order links", async () => {
      await expectSubnav("/admin/site/contact");
    });

    test("order page shows subnav with Homepage, Contact and Order links", async () => {
      await expectSubnav("/admin/site/order");
    });
  });

  describe("admin nav", () => {
    test("shows Site link when public site is enabled", async () => {
      await enablePublicSite();
      const response = await adminGet("/admin/site");
      const html = await response.text();
      assertStringIncludes(html, 'href="/admin/site"');
    });

    test("hides Site link when public site is disabled", async () => {
      const response = await adminGet("/admin/settings");
      const html = await response.text();
      assert(!html.includes('href="/admin/site"'));
    });
  });
});
