/** The /sitemap.xml document: which public URLs it lists and when it says
 * nothing. Served from the static table, so the handler reads its own
 * settings, exactly like /robots.txt. */

/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { executeWithoutCacheInvalidation } from "#db/client.ts";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { handleSitemapXml } from "#routes/sitemap.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  createTestNewsPost,
  createTestSitePage,
} from "#test-utils/db-helpers/misc.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { disablePublicSite, enablePublicSite } from "#test-utils/settings.ts";

/* jscpd:ignore-end */

describeWithEnv("server public > sitemap.xml", { db: true }, () => {
  test("answers 404 from a site before setup", async () => {
    // A site before setup has no settings table, so the feature cannot be
    // on. The document answers 404 instead of an error, like robots.txt.
    await enablePublicSite();
    await executeWithoutCacheInvalidation("DROP TABLE settings", []);
    const response = await handleRequest(mockRequest("/sitemap.xml"));
    expect(response.status).toBe(404);
  });

  test("rethrows a settings failure that is not a missing table", async () => {
    using _stub = stub(settings, "loadKeys", () =>
      Promise.reject(new Error("database unreachable")),
    );
    await expect(handleSitemapXml(mockRequest("/sitemap.xml"))).rejects.toThrow(
      "database unreachable",
    );
  });

  test("answers 404 while the public site is off", async () => {
    await disablePublicSite();
    const response = await handleRequest(mockRequest("/sitemap.xml"));
    expect(response.status).toBe(404);
  });

  test("lists the site's public pages, listings and groups", async () => {
    await enablePublicSite();
    try {
      const listing = await createTestListing({ name: "Concert Tickets" });
      await createTestListing({ hidden: true, name: "Hidden Concert" });
      const group = await createTestGroup({ name: "Package Deal" });
      await createTestGroup({ hidden: true, name: "Secret Bundle" });
      await createTestSitePage("plans");
      const post = await createTestNewsPost("Festival News");

      const response = await handleRequest(mockRequest("/sitemap.xml"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/xml");
      const xml = await response.text();
      expect(xml).toContain(
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      );
      expect(xml).toContain("<loc>https://localhost/</loc>");
      expect(xml).toContain("<loc>https://localhost/listings</loc>");
      expect(xml).toContain("<loc>https://localhost/page/plans</loc>");
      expect(xml).toContain(`<loc>https://localhost/news/${post.slug}</loc>`);
      expect(xml).toContain(
        `<loc>https://localhost/ticket/${listing.slug}</loc>`,
      );
      expect(xml).toContain(
        `<loc>https://localhost/ticket/${group.slug}</loc>`,
      );
      // A hidden listing or group is not on the public site, so the sitemap
      // does not name it. No admin path belongs in a public document either.
      expect(xml).not.toContain("hidden-concert");
      expect(xml).not.toContain("secret-bundle");
      expect(xml).not.toContain("/admin");
    } finally {
      await disablePublicSite();
    }
  });

  test("names no lastmod, because no public page kind carries a true one", async () => {
    await enablePublicSite();
    try {
      await createTestListing({ name: "Dated Listing" });
      const response = await handleRequest(mockRequest("/sitemap.xml"));
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain("<lastmod>");
    } finally {
      await disablePublicSite();
    }
  });

  test("escapes the address it lists", async () => {
    await enablePublicSite();
    try {
      await createTestSitePage("plans&pricing");
      const response = await handleRequest(mockRequest("/sitemap.xml"));
      const xml = await response.text();
      expect(xml).toContain(
        "<loc>https://localhost/page/plans&amp;pricing</loc>",
      );
    } finally {
      await disablePublicSite();
    }
  });

  test("names the configured domain over the request's host", async () => {
    await enablePublicSite();
    try {
      await settings.update.customDomain("custom.example");
      await settings.update.customDomainLastValidated();
      const response = await handleRequest(mockRequest("/sitemap.xml"));
      expect(await response.text()).toContain(
        "<loc>https://custom.example/</loc>",
      );
    } finally {
      await settings.update.customDomain("");
      await disablePublicSite();
    }
  });
});
