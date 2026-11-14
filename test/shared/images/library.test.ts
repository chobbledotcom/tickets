/** The image library's order, and the Site content rule both surfaces share. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { appendImageToItem } from "#db/images.ts";
import {
  byNameThenUpload,
  isSiteContentImageType,
  siteContentBlocksManager,
  whenSiteContentBlocksManager,
} from "#shared/images/library.ts";
import { nonEmptyString } from "#shared/validation/string.ts";
import { imageOnListingAndGroup, makeImage } from "#test-utils/admin-images.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestNewsPost,
  createTestSitePage,
} from "#test-utils/db-helpers/misc.ts";
import type { Image, ImageUseItemType } from "#types";

const libraryImage = (id: number, name: string): Image => ({
  alt_text: "",
  filename: nonEmptyString(`${id}.webp`, "test image filename"),
  filename_thumb: nonEmptyString(`${id}-thumb.webp`, "test thumb filename"),
  id,
  name,
});

describe("image library order", () => {
  test("sorts by name, then the older upload first", () => {
    const images = [
      libraryImage(4, "Banner"),
      libraryImage(2, "Banner"),
      libraryImage(3, "Avatar"),
    ];
    expect(images.toSorted(byNameThenUpload).map((image) => image.id)).toEqual([
      3, 2, 4,
    ]);
    expect(
      byNameThenUpload(libraryImage(2, "Banner"), libraryImage(5, "Banner")),
    ).toBe(-3);
    expect(
      byNameThenUpload(libraryImage(9, "Avatar"), libraryImage(1, "Banner")),
    ).toBe(-1);
  });

  test("only news posts and pages are Site content", () => {
    const types: ImageUseItemType[] = ["listing", "group", "news", "page"];
    expect(types.map(isSiteContentImageType)).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });
});

describeWithEnv("image library Site content", { db: true }, () => {
  const refusal = new Response("refused", { status: 403 });

  test("an image on a news post or a page blocks a manager only", async () => {
    const onNews = await makeImage("on-news");
    const onPage = await makeImage("on-page");
    const post = await createTestNewsPost("Opening night");
    const page = await createTestSitePage("about");
    await appendImageToItem(onNews.id, { id: post.id, kind: "news" });
    await appendImageToItem(onPage.id, { id: page.id, kind: "page" });

    expect(await siteContentBlocksManager("manager", onNews.id)).toBe(true);
    expect(await siteContentBlocksManager("manager", onPage.id)).toBe(true);
    expect(await siteContentBlocksManager("editor", onNews.id)).toBe(false);
    expect(await siteContentBlocksManager("owner", onPage.id)).toBe(false);
    expect(
      await whenSiteContentBlocksManager("manager", onNews.id, refusal),
    ).toBe(refusal);
    expect(
      await whenSiteContentBlocksManager("owner", onNews.id, refusal),
    ).toBe(null);
  });

  test("an image only on listings and groups blocks nobody", async () => {
    const { image: onListing } = await imageOnListingAndGroup(
      "on-listing",
      "Linked listing",
      "Linked group",
    );

    expect(await siteContentBlocksManager("manager", onListing.id)).toBe(false);
    expect(
      await whenSiteContentBlocksManager("manager", onListing.id, refusal),
    ).toBe(null);
  });
});
