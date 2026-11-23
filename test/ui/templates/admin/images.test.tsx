import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { IMAGE_ORDERS } from "#shared/ordered-lists.ts";
import { nonEmptyString } from "#shared/validation/string.ts";
import {
  adminImageDeletePage,
  adminImageEditPage,
  adminImageNewPage,
  adminImagesPage,
  type ImageEditContent,
  ItemImagesPanel,
  imageEditBody,
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
  altText: `Alt ${name}`,
  filename: nonEmptyString(`${name.toLowerCase()}.webp`),
  filenameThumb: nonEmptyString(`${name.toLowerCase()}-thumb.webp`),
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

/** The image library page for `images`, rendered with file storage on. */
const libraryPage = (images: Image[]): string =>
  withStorageEnabled(() => adminImagesPage(images, OWNER_SESSION));

/** The full edit page for one image's content, rendered with storage on. */
const editPage = (content: ImageEditContent): string =>
  withStorageEnabled(() =>
    adminImageEditPage({ ...content, session: OWNER_SESSION }),
  );

describe("admin image templates", () => {
  beforeAll(setupAdminPageTest);

  test("renders the library grid and hides edit actions in read-only mode", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = libraryPage([image(7, "Hero")]);

    expectIncludesAll(html, [
      '<li class="image-library-item">',
      '<h2 class="image-library-name">Hero</h2>',
      "/image/hero-thumb.webp",
    ]);
    // Read-only sessions get no edit link, no new-image link, and so no item
    // the modal can open.
    expect(html).not.toMatch(
      /href="\/admin\/images\/(?:7\/edit|new)"|data-image-edit-id/,
    );
  });

  test("renders each library image as one real edit link", () => {
    const html = libraryPage([image(7, "Hero")]);

    expectIncludesAll(html, [
      '<ul class="image-library-grid" data-image-library data-modal-loading="Loading…">',
      '<a class="image-library-open" data-image-edit-id="7" data-image-edit-name="Hero" href="/admin/images/7/edit">',
      '<h2 class="image-library-name">Hero</h2>',
      '<img alt="Alt Hero" class="image-library-thumb" src="/image/hero-thumb.webp">',
      '<p class="image-library-alt" tabindex="0">Alt Hero</p>',
    ]);
    // The library no longer renders a table row.
    assert(!html.includes("<table"));
  });

  test("renders an image with no alt text without an alt box", () => {
    const html = libraryPage([{ ...image(4, "No alt"), altText: "" }]);

    assert(!html.includes("image-library-alt"));
  });

  test("renders the thumbnail from the image thumbnail filename", () => {
    const html = libraryPage([image(8, "Poster")]);

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

  test("lazy-loads library thumbnails from the tenth image on the page", () => {
    const html = libraryPage(images(12));

    expectThumbnailRule(html, 12);
    expectIncludesAll(html, [
      '<img alt="Alt Image 9" class="image-library-thumb" src="/image/image 9-thumb.webp">',
      '<img alt="Alt Image 10" class="image-library-thumb" loading="lazy" src="/image/image 10-thumb.webp">',
    ]);
  });

  test("loads every library thumbnail with the page at nine images", () => {
    expectThumbnailRule(libraryPage(images(9)), 9);
  });

  test("renders the empty-library message when there are no images", () => {
    assertStringIncludes(libraryPage([]), "No images yet.");
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
        '<input maxlength="250" name="altText" type="text">',
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

  test("renders one edit body for the full page and the modal", () => {
    const content = {
      image: image(3, "Poster"),
      options: [
        { active: true, id: 4, label: "Listing A", type: "listing" as const },
      ],
      selected: new Set<string>(),
    };
    const body = String(imageEditBody(content));
    const page = editPage(content);

    // The page carries exactly the body the modal loads.
    assertStringIncludes(page, body);
    expectIncludesAll(body, [
      '<div class="image-library-preview">',
      '<form action="/admin/images/3/edit" autocomplete="off" method="POST">',
      'name="csrfToken"',
      'value="Poster"',
      'value="listing:4"',
    ]);
    // The body carries no page heading of its own.
    assert(!body.includes("Edit Poster"));
  });

  test("renders the edit form with its fields and delete action", () => {
    const html = editPage({
      image: image(3, "Poster"),
      options: [
        { active: true, id: 4, label: "Listing A", type: "listing" },
        { active: true, id: 5, label: "Group B", type: "group" },
      ],
      selected: new Set(["group:5"]),
    });

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
      'checked name="imageItems" type="checkbox" value="group:5"',
      '<a class="active" href="/admin/images">',
      '<div class="prose"><h2>Danger zone</h2>',
      'class="btn secondary"',
      "/icons.svg#trash-2",
      'href="/admin/images/3/delete"',
    ]);
  });

  test("renders each kind of linked item set", () => {
    // News posts and pages get their own labelled rows.
    expectIncludesAll(
      editPage({
        image: image(8, "Shared"),
        options: [
          { active: true, id: 1, label: "A post", type: "news" },
          { active: true, id: 2, label: "A page", type: "page" },
        ],
        selected: new Set(["page:2"]),
      }),
      [
        '<li class="checkboxes"><strong>News:</strong>',
        '<li class="checkboxes"><strong>Pages:</strong>',
        'value="news:1"',
        'checked name="imageItems" type="checkbox" value="page:2"',
      ],
    );

    // An image linked to listings only names the listings it links.
    const listingsOnly = editPage({
      image: image(6, "Solo"),
      options: [
        { active: true, id: 4, label: "Listing A", type: "listing" },
        { active: false, id: 7, label: "Retired listing", type: "listing" },
      ],
      selected: new Set(["listing:4"]),
    });
    expectIncludesAll(listingsOnly, [
      "<strong>Linked listings (1):</strong>",
      '<label class="muted"><input name="imageItems" type="checkbox" value="listing:7"',
    ]);
    assert(!listingsOnly.includes("Linked items"));
    expect(listingsOnly.indexOf('value="listing:4"')).toBeLessThan(
      listingsOnly.indexOf('value="listing:7"'),
    );

    // An image with no links says so.
    assertStringIncludes(
      editPage({
        image: image(9, "Unlinked"),
        options: [],
        selected: new Set(),
      }),
      "No listings or groups yet.",
    );
  });

  test("renders the edit body without a delete action in read-only mode", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const body = withStorageEnabled(() =>
      String(
        imageEditBody({
          image: image(3, "Poster"),
          options: [],
          selected: new Set(),
        }),
      ),
    );

    expectIncludesAll(body, [
      '<form action="/admin/images/3/edit"',
      'value="Poster"',
    ]);
    // The delete route refuses a read-only session, so the body names no
    // delete action.
    assert(!body.includes('href="/admin/images/3/delete"'));
    assert(!body.includes("Danger zone"));
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
          reorder: IMAGE_ORDERS.listing.column(1),
          uploadAction: "/admin/listing/1/images/upload",
        }),
      );

      assertStringIncludes(html, "File storage is not configured.");
      assert(!html.includes("Current images"));
      assert(!html.includes('action="/admin/listing/1/images"'));
      assert(!html.includes('name="imageIds"'));
      assert(!html.includes('type="file"'));
    }));

  test("renders linked item images without edit links in read-only mode", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    withStorageEnabled(() => {
      const html = String(
        ItemImagesPanel({
          action: "/admin/listing/1/images",
          allImages: [image(1, "Current")],
          linkedImages: [image(1, "Current")],
          reorder: IMAGE_ORDERS.listing.column(1),
          uploadAction: "/admin/listing/1/images/upload",
        }),
      );

      expectIncludesAll(html, ["Current", "/image/current-thumb.webp"]);
      assert(!html.includes('href="/admin/images/1/edit"'));
    });
  });

  test("renders empty item image selection and enabled upload form", () =>
    withStorageEnabled(() => {
      const html = String(
        ItemImagesPanel({
          action: "/admin/listing/1/images",
          allImages: [],
          linkedImages: [],
          reorder: IMAGE_ORDERS.listing.column(1),
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
          reorder: IMAGE_ORDERS.listing.column(1),
          uploadAction: "/admin/listing/1/images/upload",
        }),
      );

      expectIncludesAll(html, [
        '<fieldset class="checkboxes image-picker-checkboxes">',
        "/icons.svg#plus",
      ]);
      const first = html.indexOf('name="imageIds" type="checkbox" value="1"');
      const second = html.indexOf('name="imageIds" type="checkbox" value="2"');
      const library = html.indexOf('name="imageIds" type="checkbox" value="3"');
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
          reorder: IMAGE_ORDERS.listing.column(1),
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
          reorder: IMAGE_ORDERS.listing.column(1),
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
          reorder: IMAGE_ORDERS.listing.column(1),
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
