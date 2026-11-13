import { assert, assertStringIncludes } from "@std/assert";
import { it as test } from "@std/testing/bdd";
import { setItemsForImage } from "#db/images.ts";
import { formatCurrency } from "#shared/currency.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import { assertPublicHtml, expectIncludesAll } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { enablePublicSite, withSetting } from "#test-utils/settings.ts";

describeWithEnv(
  "server public > listings catalog gallery",
  { db: true, triggers: true },
  () => {
    test("default keeps the prose cards when the gallery is off", async () => {
      await enablePublicSite();
      await createTestListing({ name: "Plain Listing" });
      const html = await assertPublicHtml("/listings", "Plain Listing");
      assert(!html.includes('class="card-grid"'));
      assert(!html.includes("card-image"));
    });

    test("gallery renders product cards with image, price, and link", async () => {
      await enablePublicSite();
      const listing = await createTestListing({
        name: "Gallery Product",
        unitPrice: 3000,
      });
      const image = await makeImage("Gallery Poster");
      await setItemsForImage(image.id, [{ id: listing.id, kind: "listing" }]);
      await withSetting({ catalog_gallery_enabled: true }, async () => {
        const html = await assertPublicHtml("/listings", "Gallery Product");
        expectIncludesAll(html, [
          'class="card-grid"',
          `<a class="card" href="/ticket/${listing.slug}">`,
          'class="card-image"',
          image.filename_thumb,
          `alt="Alt Gallery Poster"`,
          `<span class="card-price">${formatCurrency(3000)}</span>`,
        ]);
        // The gallery card is an index: no prose block, no full description.
        assert(!html.includes('<div class="prose"><h2>Gallery Product</h2>'));
      });
    });

    test("a sold-out listing keeps its card but loses the link", async () => {
      await enablePublicSite();
      const listing = await createTestListing({
        maxAttendees: 1,
        name: "Gallery Full",
      });
      await bookAttendee(listing, {
        email: "a@test.com",
        name: "Attendee",
        quantity: 1,
      });
      await withSetting({ catalog_gallery_enabled: true }, async () => {
        const html = await assertPublicHtml("/listings", "Gallery Full");
        assertStringIncludes(html, '<div class="card">');
        assertStringIncludes(html, "Sold Out");
        assert(!html.includes(`href="/ticket/${listing.slug}"`));
      });
    });
  },
);
