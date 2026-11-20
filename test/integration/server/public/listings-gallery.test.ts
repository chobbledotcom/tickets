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
import { enablePublicSite } from "#test-utils/settings.ts";

/** Give one listing a library picture and return it. */
const attachImage = async (listingId: number, name: string) => {
  const image = await makeImage(name);
  await setItemsForImage(image.id, [{ id: listingId, kind: "listing" }]);
  return image;
};

describeWithEnv(
  "server public > listings catalog gallery",
  { db: true, triggers: true },
  () => {
    test("shows product cards when most listings have an image", async () => {
      await enablePublicSite();
      const listing = await createTestListing({
        location: "Gallery Hall",
        name: "Gallery Product",
        unitPrice: 3000,
      });
      const image = await attachImage(listing.id, "Gallery Poster");

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

    test("keeps prose when images are not the majority", async () => {
      await enablePublicSite();
      const pictured = await createTestListing({ name: "Gallery Pictured" });
      await createTestListing({ name: "Gallery Plain" });
      await attachImage(pictured.id, "Gallery Pictured Poster");

      const html = await assertPublicHtml("/listings", "Gallery Pictured");
      assert(html.includes('<div class="prose"><h2>Gallery Pictured</h2>'));
      assert(!html.includes('class="card-grid"'));
      assert(!html.includes("card-image"));
    });

    test("a dated daily listing keeps the date on its gallery link", async () => {
      await enablePublicSite();
      const daily = await createDailyTestListing({
        maxAttendees: 100,
        minimumDaysBefore: 0,
        name: "Gallery Daily",
      });
      await attachImage(daily.id, "Gallery Daily Poster");

      const html = await assertPublicHtml(
        "/listings?date=2026-12-31",
        "Gallery Daily",
      );
      assert(html.includes(`href="/ticket/${daily.slug}?date=2026-12-31"`));
    });

    test("a closed listing lands in the unavailable gallery grid", async () => {
      await enablePublicSite();
      const closed = await createTestListing({
        closesAt: pastCloseTime(),
        maxAttendees: 100,
        name: "Gallery Closed",
      });
      await attachImage(closed.id, "Gallery Closed Poster");

      const html = await assertPublicHtml(
        "/listings?date=2026-06-16",
        "Gallery Closed",
      );
      expectIncludesAll(html, ['class="card-grid"', "Unavailable"]);
    });
  },
);
