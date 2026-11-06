import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { nonEmptyString } from "#shared/validation/string.ts";
import {
  adminImageDeletePage,
  adminImageEditPage,
  adminImageNewPage,
  adminImagesPage,
  ItemImagesPanel,
} from "#templates/admin/images.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { withEnv } from "#test-utils/env.ts";
import { withStorageDisabled, withStorageEnabled } from "#test-utils/mocks.ts";
import type { Image } from "#types";

const image = (id: number, name: string): Image => ({
  alt_text: `Alt ${name}`,
  filename: nonEmptyString(`${name.toLowerCase()}.webp`),
  filename_thumb: nonEmptyString(`${name.toLowerCase()}-thumb.webp`),
  id,
  name,
});

/** Images named Image 1 ... Image `count`, so a test can name the thumbnail
 *  that changes over to a late load. */
const images = (count: number): Image[] =>
  Array.from({ length: count }, (_, index) =>
    image(index + 1, `Image ${index + 1}`),
  );

/** The admin page rule: the first nine image thumbnails of a page load with
 *  it. From the tenth thumbnail, the browser waits until the reader scrolls
 *  near it. */
const EAGER_THUMBNAILS_PER_PAGE = 9;

/** How each image thumbnail of the page loads, in the order the page shows it:
 *  true when the browser waits to load the thumbnail. */
const lazyThumbnails = (html: string): boolean[] =>
  html
    .split("<img ")
    .slice(1)
    .map((rest) => rest.slice(0, rest.indexOf(">")))
    .filter((tag) => tag.includes('class="image-library-thumb"'))
    .map((tag) => tag.includes('loading="lazy"'));

/** Check the page rule over every thumbnail the page shows: the page renders
 *  `count` thumbnails, the first nine load with it, and each later thumbnail
 *  waits for the scroll. */
const expectThumbnailRule = (html: string, count: number): void =>
  expect(lazyThumbnails(html)).toEqual(
    Array.from(
      { length: count },
      (_, position) => position >= EAGER_THUMBNAILS_PER_PAGE,
    ),
  );

describe("admin image templates", () => {
  beforeAll(setupAdminPageTest);

  test("renders the library table and hides edit actions in read-only mode", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    withStorageEnabled(() => {
      const html = adminImagesPage([image(7, "Hero")], OWNER_SESSION);
      expectIncludesAll(html, ["Hero", "/image/hero-thumb.webp"]);
      assert(!html.includes('href="/admin/images/7/edit"'));
      assert(!html.includes('href="/admin/images/new"'));
    });
  });

  test("renders the thumbnail from the image thumbnail filename", () => {
    withStorageEnabled(() => {
      const html = adminImagesPage([image(8, "Poster")], OWNER_SESSION);
      assertStringIncludes(
        html,
        '<img alt="Alt Poster" class="image-library-thumb" src="/image/poster-thumb.webp">',
      );
      assert(!html.includes("/image/poster.webp"));
      expectIncludesAll(html, [
        '<a class="active" href="/admin/images">',
        'href="/admin/guide#images"',
      ]);
    });
  });

  test("lazy-loads library thumbnails from the tenth image on the page", () => {
    withStorageEnabled(() => {
      const html = adminImagesPage(images(12), OWNER_SESSION);

      expectThumbnailRule(html, 12);
      expectIncludesAll(html, [
        '<img alt="Alt Image 9" class="image-library-thumb" src="/image/image 9-thumb.webp">',
        '<img alt="Alt Image 10" class="image-library-thumb" loading="lazy" src="/image/image 10-thumb.webp">',
      ]);
    });
  });

  test("loads every library thumbnail with the page at nine images", () => {
    withStorageEnabled(() => {
      expectThumbnailRule(adminImagesPage(images(9), OWNER_SESSION), 9);
    });
  });

  test("renders the empty-library message when there are no images", () => {
    withStorageEnabled(() => {
      const html = adminImagesPage([], OWNER_SESSION);
      assertStringIncludes(html, "No images yet.");
    });
  });

  test("hides the image library table and actions when storage is disabled", () => {
    withStorageDisabled(() => {
      const html = adminImagesPage([image(8, "Poster")], OWNER_SESSION);
      assertStringIncludes(
        html,
        '<p class="notice">File storage is not configured.</p>',
      );
      assert(!html.includes('href="/admin/images/new"'));
      assert(!html.includes("/image/poster-thumb.webp"));
      assert(!html.includes("Poster"));
    });
  });

  test("renders the new image upload form", () => {
    withStorageEnabled(() => {
      const html = adminImageNewPage(OWNER_SESSION, "Upload failed");
      expectIncludesAll(html, [
        "Upload failed",
        'action="/admin/images"',
        'enctype="multipart/form-data"',
        '<a class="active" href="/admin/images">',
        '<input maxlength="250" name="name" required type="text">',
        '<input maxlength="250" name="alt_text" type="text">',
        '<input accept="image/jpeg,image/png,image/webp" name="image" type="file">',
        "/icons.svg#save",
      ]);
    });
  });

  test("renders the new image disabled state when storage is disabled", () => {
    withStorageDisabled(() => {
      const html = adminImageNewPage(OWNER_SESSION, "Upload failed");
      expectIncludesAll(html, [
        "Upload failed",
        "File storage is not configured.",
      ]);
      assert(!html.includes('enctype="multipart/form-data"'));
      assert(!html.includes('name="image"'));
    });
  });

  test("renders edit fields, linked item checkboxes, and delete action", () => {
    const html = withStorageEnabled(() =>
      adminImageEditPage({
        image: image(3, "Poster"),
        options: [
          { active: true, id: 4, label: "Listing A", type: "listing" },
          { active: true, id: 5, label: "Group B", type: "group" },
        ],
        selected: new Set(["group:5"]),
        session: OWNER_SESSION,
      }),
    );

    expectIncludesAll(html, [
      "Edit Poster",
      '<div class="image-library-preview">',
    ]);
    // One preview thumbnail loads with the page.
    expect(lazyThumbnails(html)).toEqual([false]);
    expectIncludesAll(html, [
      'value="Poster"',
      "<strong>Linked items (1):</strong>",
      '<li class="checkboxes"><strong>Listings:</strong>',
      '<li class="checkboxes"><strong>Groups:</strong>',
      'value="listing:4"',
      'checked name="image_items" type="checkbox" value="group:5"',
      '<a class="active" href="/admin/images">',
      '<div class="prose"><h2>Danger zone</h2>',
      'class="btn secondary"',
      "/icons.svg#trash-2",
      'href="/admin/images/3/delete"',
    ]);
  });

  test("groups news and page targets under their own labelled rows", () => {
    const html = withStorageEnabled(() =>
      adminImageEditPage({
        image: image(8, "Shared"),
        options: [
          { active: true, id: 1, label: "A post", type: "news" },
          { active: true, id: 2, label: "A page", type: "page" },
        ],
        selected: new Set(["page:2"]),
        session: OWNER_SESSION,
      }),
    );

    expectIncludesAll(html, [
      '<li class="checkboxes"><strong>News:</strong>',
      '<li class="checkboxes"><strong>Pages:</strong>',
      'value="news:1"',
      'checked name="image_items" type="checkbox" value="page:2"',
    ]);
  });

  test("renders a listings-only image as a single linked-listings line", () => {
    const html = adminImageEditPage({
      image: image(6, "Solo"),
      options: [
        { active: true, id: 4, label: "Listing A", type: "listing" },
        { active: false, id: 7, label: "Retired listing", type: "listing" },
      ],
      selected: new Set(["listing:4"]),
      session: OWNER_SESSION,
    });

    assertStringIncludes(html, "<strong>Linked listings (1):</strong>");
    assert(!html.includes("Linked items"));
    const active = html.indexOf('value="listing:4"');
    const retired = html.indexOf('value="listing:7"');
    expect(active).toBeGreaterThan(-1);
    expect(retired).toBeGreaterThan(active);
    assertStringIncludes(
      html,
      '<label class="muted"><input name="image_items" type="checkbox" value="listing:7"',
    );
  });

  test("renders edit empty linked-item state", () => {
    const html = adminImageEditPage({
      image: image(9, "Unlinked"),
      options: [],
      selected: new Set(),
      session: OWNER_SESSION,
    });
    assertStringIncludes(html, "No listings or groups yet.");
  });

  test("renders the delete confirmation page", () => {
    const html = withStorageEnabled(() =>
      adminImageDeletePage(image(2, "Remove me"), OWNER_SESSION, "Nope"),
    );
    expectIncludesAll(html, [
      "Delete Remove me",
      "Nope",
      'action="/admin/images/2/delete"',
      '<a class="active" href="/admin/images">',
      '<button class="danger" type="submit">',
      "Type the image name to confirm",
    ]);
  });

  test("renders item image storage-disabled state", () =>
    withStorageDisabled(() => {
      const html = String(
        ItemImagesPanel({
          action: "/admin/listing/1/images",
          allImages: [image(1, "Current"), image(2, "Other")],
          linkedImages: [image(1, "Current")],
          uploadAction: "/admin/listing/1/images/upload",
        }),
      );

      assertStringIncludes(html, "File storage is not configured.");
      assert(!html.includes("Current images"));
      assert(!html.includes('action="/admin/listing/1/images"'));
      assert(!html.includes('name="image_ids"'));
      assert(!html.includes('type="file"'));
    }));

  test("renders empty item image selection and enabled upload form", () =>
    withStorageEnabled(() => {
      const html = String(
        ItemImagesPanel({
          action: "/admin/listing/1/images",
          allImages: [],
          linkedImages: [],
          uploadAction: "/admin/listing/1/images/upload",
        }),
      );

      expectIncludesAll(html, [
        "No images linked.",
        "No images yet.",
        'enctype="multipart/form-data"',
        'name="image"',
      ]);
    }));

  test("renders selected item image checkboxes in current item order", () =>
    withStorageEnabled(() => {
      const html = String(
        ItemImagesPanel({
          action: "/admin/listing/1/images",
          allImages: [
            image(3, "Library"),
            image(2, "Second"),
            image(1, "First"),
          ],
          linkedImages: [image(1, "First"), image(2, "Second")],
          uploadAction: "/admin/listing/1/images/upload",
        }),
      );

      expectIncludesAll(html, [
        '<fieldset class="checkboxes image-picker-checkboxes">',
        "/icons.svg#plus",
      ]);
      const first = html.indexOf('name="image_ids" type="checkbox" value="1"');
      const second = html.indexOf('name="image_ids" type="checkbox" value="2"');
      const library = html.indexOf(
        'name="image_ids" type="checkbox" value="3"',
      );
      expect(first).toBeGreaterThan(-1);
      expect(second).toBeGreaterThan(first);
      expect(library).toBeGreaterThan(second);
    }));

  test("continues the lazy thumbnail count from the linked table into the image picker", () =>
    withStorageEnabled(() => {
      const linked = images(9);
      const html = String(
        ItemImagesPanel({
          action: "/admin/listing/1/images",
          allImages: linked,
          linkedImages: linked,
          uploadAction: "/admin/listing/1/images/upload",
        }),
      );

      // Nine linked rows above push the picker past the eager nine, so every
      // picker thumbnail is the tenth image of the page or later.
      expectThumbnailRule(html, 18);
      assertStringIncludes(
        html,
        '<img alt="Alt Image 1" class="image-library-thumb" loading="lazy" src="/image/image 1-thumb.webp">',
      );
    }));

  test("counts picker thumbnails from the linked rows, not from the library size", () =>
    withStorageEnabled(() => {
      const library = images(12);
      const html = String(
        ItemImagesPanel({
          action: "/admin/listing/1/images",
          allImages: library,
          linkedImages: library.slice(0, 2),
          uploadAction: "/admin/listing/1/images/upload",
        }),
      );

      // Two linked rows above put the picker entry for Image 8 at position 9.
      expectThumbnailRule(html, 14);
      expectIncludesAll(html, [
        '<img alt="Alt Image 7" class="image-library-thumb" src="/image/image 7-thumb.webp">',
        '<img alt="Alt Image 8" class="image-library-thumb" loading="lazy" src="/image/image 8-thumb.webp">',
      ]);
    }));

  test("starts the picker thumbnail count at the page top with nothing linked", () =>
    withStorageEnabled(() => {
      const html = String(
        ItemImagesPanel({
          action: "/admin/listing/1/images",
          allImages: images(12),
          linkedImages: [],
          uploadAction: "/admin/listing/1/images/upload",
        }),
      );

      assertStringIncludes(html, "No images linked.");
      expectThumbnailRule(html, 12);
      assertStringIncludes(
        html,
        '<img alt="Alt Image 10" class="image-library-thumb" loading="lazy" src="/image/image 10-thumb.webp">',
      );
    }));
});
