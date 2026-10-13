/** The /sitemap.xml document: which public URLs it lists and when it says
 * nothing. Served from the static table, so the handler reads its own
 * settings, exactly like /robots.txt. */

/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { hmacHash } from "#crypto/hashing.ts";
import { executeWithoutCacheInvalidation } from "#db/client.ts";
import { listingChildren } from "#db/listing-parents.ts";
import {
  invalidateListingsCache,
  listingsTable,
} from "#db/listings/records.ts";
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
import { testListingInput } from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { soldOutParentInGroup } from "#test-utils/parents.ts";
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
      const group = await createTestGroup({ name: "Package Deal" });
      const listing = await createTestListing({
        groupIds: [group.id],
        name: "Concert Tickets",
      });
      await createTestListing({ hidden: true, name: "Hidden Concert" });
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
      expect(xml).toContain("<loc>https://localhost/news</loc>");
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

  test("lists a fixed page only when its handler serves it", async () => {
    await enablePublicSite();
    try {
      // With no terms text, no contact content, the order page off, and no
      // news posts, each of those pages answers 404, so the sitemap names
      // none of them. Home and /listings always serve behind the gate.
      const empty = await (
        await handleRequest(mockRequest("/sitemap.xml"))
      ).text();
      expect(empty).toContain("<loc>https://localhost/</loc>");
      expect(empty).toContain("<loc>https://localhost/listings</loc>");
      expect(empty).not.toContain("<loc>https://localhost/terms</loc>");
      expect(empty).not.toContain("<loc>https://localhost/contact</loc>");
      expect(empty).not.toContain("<loc>https://localhost/order</loc>");
      expect(empty).not.toContain("<loc>https://localhost/news</loc>");

      // Give every page what its handler requires, and the document lists it.
      await settings.update.orderEnabled(true);
      await settings.update.terms("Be kind to the venue.");
      await settings.update.contactPageText("Write to us at the desk.");
      await createTestNewsPost("Opening Week");
      const served = await (
        await handleRequest(mockRequest("/sitemap.xml"))
      ).text();
      expect(served).toContain("<loc>https://localhost/terms</loc>");
      expect(served).toContain("<loc>https://localhost/contact</loc>");
      expect(served).toContain("<loc>https://localhost/order</loc>");
      expect(served).toContain("<loc>https://localhost/news</loc>");
    } finally {
      await settings.update.orderEnabled(false);
      await settings.update.terms("");
      await settings.update.contactPageText("");
      await disablePublicSite();
    }
  });

  test("lists a listing only when its /ticket page would serve it", async () => {
    await enablePublicSite();
    try {
      const parent = await createTestListing({ name: "Parent Deal" });
      const child = await createTestListing({ name: "Child Seat" });
      await listingChildren.setIds(parent.id, [child.id]);
      await createTestListing({ active: false, name: "Paused Concert" });

      const xml = await (
        await handleRequest(mockRequest("/sitemap.xml"))
      ).text();
      // A child that sells only through its parent has no /ticket page of
      // its own, and a paused listing answers 404. The parent stays in.
      expect(xml).not.toContain(child.slug);
      expect(xml).not.toContain("paused-concert");
      expect(xml).toContain(
        `<loc>https://localhost/ticket/${parent.slug}</loc>`,
      );
    } finally {
      await disablePublicSite();
    }
  });

  test("lists a group only when its page still offers a booking", async () => {
    await enablePublicSite();
    try {
      await createTestGroup({ name: "Members Only Club" });

      // No member, no bookable page, so the group is out.
      const xml = await (
        await handleRequest(mockRequest("/sitemap.xml"))
      ).text();
      expect(xml).not.toContain("members-only-club");
    } finally {
      await disablePublicSite();
    }
  });

  test("names a regular group whose sole member is a sold-out parent", async () => {
    await enablePublicSite();
    try {
      const { group } = await soldOutParentInGroup("Sold-out parent group");

      // The regular group's page serves: it renders its sold-out member.
      const page = await handleRequest(mockRequest(`/ticket/${group.slug}`));
      expect(page.status).toBe(200);

      const xml = await (
        await handleRequest(mockRequest("/sitemap.xml"))
      ).text();
      expect(xml).toContain(
        `<loc>https://localhost/ticket/${group.slug}</loc>`,
      );
    } finally {
      await disablePublicSite();
    }
  });

  test("names no listing or group whose slug the route rejects", async () => {
    await enablePublicSite();
    try {
      // The edit form refuses an unroutable slug, so the listing write goes
      // to the stored row: the malleable-data case the filter exists for.
      const rejected = await createTestListing({ name: "Ampersand Deal" });
      await listingsTable.update(rejected.id, {
        ...testListingInput({ name: "Ampersand Deal" }),
        slug: "plans&pricing",
        slugIndex: await hmacHash("plans&pricing"),
      });
      // A group enters the document only when a member makes its page
      // bookable, so each group under test carries one.
      const odd = await createTestGroup({
        name: "Odd Bundle",
        slug: "plans&pricing",
      });
      await createTestListing({ groupIds: [odd.id], name: "Odd Member" });
      const plain = await createTestListing({ name: "Plain Deal" });
      const plainGroup = await createTestGroup({ name: "Plain Bundle" });
      await createTestListing({
        groupIds: [plainGroup.id],
        name: "Plain Member",
      });

      const xml = await (
        await handleRequest(mockRequest("/sitemap.xml"))
      ).text();
      // The route's slug pattern rejects the ampersand, so those /ticket
      // pages answer 404 and stay out. A normal slug stays in.
      expect(xml).not.toContain(
        "<loc>https://localhost/ticket/plans&pricing</loc>",
      );
      expect(xml).not.toContain(
        "<loc>https://localhost/ticket/plans&amp;pricing</loc>",
      );
      expect(xml).toContain(
        `<loc>https://localhost/ticket/${plain.slug}</loc>`,
      );
      expect(xml).toContain(
        `<loc>https://localhost/ticket/${plainGroup.slug}</loc>`,
      );
    } finally {
      await disablePublicSite();
    }
  });

  test("a cold read applies the inherited hidden flag", async () => {
    await enablePublicSite();
    try {
      const listing = await createTestListing({
        hidden: false,
        name: "Inherits Secret",
        useDefaults: true,
      });
      await settings.update.listingDefaults({ hidden: true });
      // A fresh isolate holds neither the settings snapshot nor a decrypted
      // catalog; drop both, so the handler's own load decides.
      settings.invalidateCache();
      invalidateListingsCache();
      const xml = await (
        await handleRequest(mockRequest("/sitemap.xml"))
      ).text();
      expect(xml).not.toContain(listing.slug);
    } finally {
      await settings.update.listingDefaults({});
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

  test("names no page whose slug the route rejects", async () => {
    await enablePublicSite();
    try {
      await createTestSitePage("plans&pricing");
      const response = await handleRequest(mockRequest("/sitemap.xml"));
      const xml = await response.text();
      // The public route's slug pattern rejects the ampersand, so the page
      // answers 404 and the document names no URL for it.
      expect(xml).not.toContain("plans&amp;pricing");
      expect(xml).not.toContain("plans&pricing");
    } finally {
      await disablePublicSite();
    }
  });

  test("names no page whose stored slug ends in a line terminator", async () => {
    await enablePublicSite();
    try {
      await createTestSitePage("latest\n");
      const response = await handleRequest(mockRequest("/sitemap.xml"));
      const xml = await response.text();
      // URL parsing drops the trailing newline, so the served page and its
      // stored slug no longer match: the document names no URL for it.
      expect(xml).not.toContain("page/latest");
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
