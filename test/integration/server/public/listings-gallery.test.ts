import { assert } from "@std/assert";
import { it as test } from "@std/testing/bdd";
import { setItemsForImage } from "#db/images.ts";
import { formatCurrency } from "#shared/currency.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import { assertPublicHtml, expectIncludesAll } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createDailyTestListing,
  createTestListing,
  pastCloseTime,
} from "#test-utils/db-helpers/listings.ts";
import { enablePublicSite, withSetting } from "#test-utils/settings.ts";

describeWithEnv(
  "server public > listings catalog gallery",
  { db: true, triggers: true },
  () => {
    test("the setting switches the listings page to product cards", async () => {
      await enablePublicSite();
      const listing = await createTestListing({
        location: "Gallery Hall",
        name: "Gallery Product",
        unitPrice: 3000,
      });
      const image = await makeImage("Gallery Poster");
      await setItemsForImage(image.id, [{ id: listing.id, kind: "listing" }]);

      const prose = await assertPublicHtml("/listings", "Gallery Product");
      assert(!prose.includes('class="card-grid"'));
      assert(!prose.includes("card-image"));

      await withSetting({ catalog_gallery_enabled: true }, async () => {
        const html = await assertPublicHtml("/listings", "Gallery Product");
        expectIncludesAll(html, [
          'class="card-grid"',
          `<a class="card" href="/ticket/${listing.slug}">`,
          'class="card-image"',
          image.filenameThumb,
          `alt="Alt Gallery Poster"`,
          "Gallery Hall",
          `<span class="card-price">${formatCurrency(3000)}</span>`,
        ]);
        // The gallery card is an index: no prose block, no full description.
        assert(!html.includes('<div class="prose"><h2>Gallery Product</h2>'));
      });
    });

    test("a dated daily listing keeps the date on its gallery link", async () => {
      await enablePublicSite();
      const daily = await createDailyTestListing({
        maxAttendees: 100,
        minimumDaysBefore: 0,
        name: "Gallery Daily",
      });

      await withSetting({ catalog_gallery_enabled: true }, async () => {
        const html = await assertPublicHtml(
          "/listings?date=2026-12-31",
          "Gallery Daily",
        );
        assert(html.includes(`href="/ticket/${daily.slug}?date=2026-12-31"`));
      });
    });

    test("a closed listing lands in the unavailable gallery grid", async () => {
      await enablePublicSite();
      await createTestListing({
        closesAt: pastCloseTime(),
        maxAttendees: 100,
        name: "Gallery Closed",
      });

      await withSetting({ catalog_gallery_enabled: true }, async () => {
        const html = await assertPublicHtml(
          "/listings?date=2026-06-16",
          "Gallery Closed",
        );
        expectIncludesAll(html, ['class="card-grid"', "Unavailable"]);
      });
    });
  },
);
