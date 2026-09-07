/**
 * Branch cover for the picture gallery on a public listing or group page
 *
 * The gallery is one shared block, used by news posts and by the pages a
 * visitor books from. These prove the markup a browser needs to page through
 * the pictures without any script — the thumbnail labels the radio inputs
 * they drive — which is a rendering contract rather than anything a story
 * could state in a visitor's words.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { appendImageToItem, imagesTable } from "#db/images.ts";
import { handleRequest } from "#routes";
import { nonEmptyString } from "#shared/validation/string.ts";
import {
  assertPublicHtml,
  expectHtmlResponse,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";

// jscpd:ignore-end

/** Two pictures on one thing: the first with words describing it, the second
 * without, so a missing description cannot take the gallery down with it. */
const twoPictures = async (
  itemType: "group" | "listing",
  itemId: number,
): Promise<void> => {
  const first = await imagesTable.insert({
    altText: "First alt",
    filename: nonEmptyString("gallery-one.webp"),
    filenameThumb: nonEmptyString("gallery-one-thumb.webp"),
    name: "One",
  });
  const second = await imagesTable.insert({
    altText: "",
    filename: nonEmptyString("gallery-two.webp"),
    filenameThumb: nonEmptyString("gallery-two-thumb.webp"),
    name: "Two",
  });
  await appendImageToItem(first.id, { id: itemId, kind: itemType });
  await appendImageToItem(second.id, { id: itemId, kind: itemType });
};

describeWithEnv(
  "server public > picture galleries",
  { db: true, triggers: true },
  () => {
    test("a listing's own page carries the shared gallery", async () => {
      const listing = await createTestListing({ name: "Illustrated" });
      await twoPictures("listing", listing.id);

      const response = await handleRequest(
        mockRequest(`/ticket/${listing.slug}`),
      );
      expect(response.headers.get("x-robots-tag")).toBe("index, follow");
      const html = await expectHtmlResponse(response, 200);
      expect(html).toContain('class="news-gallery"');
      expect(html).toContain("gallery-one.webp");
      expect(html).toContain('alt="First alt"');
      // Each thumbnail is a label for the radio input that shows its picture,
      // so the gallery works with no script at all.
      expect(html).toContain(
        '<label class="news-gallery-thumb" for="news-gallery-1">',
      );
    });

    test("a group's own page carries the group's pictures", async () => {
      const group = await createTestGroup({ name: "Bundle", slug: "bundle" });
      await createTestListing({
        groupId: group.id,
        maxAttendees: 50,
        name: "Member",
      });
      await twoPictures("group", group.id);

      const html = await assertPublicHtml(`/ticket/${group.slug}`);
      expect(html).toContain('class="news-gallery"');
      expect(html).toContain("gallery-one.webp");
    });
  },
);
