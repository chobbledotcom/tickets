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

describe("admin image templates", () => {
  beforeAll(setupAdminPageTest);

  test("renders the library table and hides edit actions in read-only mode", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    withStorageEnabled(() => {
      const html = adminImagesPage([image(7, "Hero")], OWNER_SESSION);
      assertStringIncludes(html, "Hero");
      assertStringIncludes(html, "/image/hero-thumb.webp");
      assert(
        !html.includes('href="/admin/images/7/edit"'),
        "the value should not contain the searched item",
      );
      assert(
        !html.includes('href="/admin/images/new"'),
        "the value should not contain the searched item",
      );
    });
  });

  test("renders the thumbnail from the image thumbnail filename", () => {
    withStorageEnabled(() => {
      const html = adminImagesPage([image(8, "Poster")], OWNER_SESSION);
      assertStringIncludes(
        html,
        '<img alt="Alt Poster" class="image-library-thumb" src="/image/poster-thumb.webp">',
      );
      assert(
        !html.includes("/image/poster.webp"),
        "the value should not contain the searched item",
      );
      assertStringIncludes(html, '<a class="active" href="/admin/images">');
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
      assert(
        !html.includes('href="/admin/images/new"'),
        "the value should not contain the searched item",
      );
      assert(
        !html.includes("/image/poster-thumb.webp"),
        "the value should not contain the searched item",
      );
      assert(
        !html.includes("Poster"),
        "the value should not contain the searched item",
      );
    });
  });

  test("renders the new image upload form", () => {
    withStorageEnabled(() => {
      const html = adminImageNewPage(OWNER_SESSION, "Upload failed");
      assertStringIncludes(html, "Upload failed");
      assertStringIncludes(html, 'action="/admin/images"');
      assertStringIncludes(html, 'enctype="multipart/form-data"');
      assertStringIncludes(html, '<a class="active" href="/admin/images">');
      assertStringIncludes(
        html,
        '<input maxlength="250" name="name" required type="text">',
      );
      assertStringIncludes(
        html,
        '<input maxlength="250" name="alt_text" type="text">',
      );
      assertStringIncludes(
        html,
        '<input accept="image/jpeg,image/png,image/webp" name="image" type="file">',
      );
      assertStringIncludes(html, "/icons.svg#save");
    });
  });

  test("renders the new image disabled state when storage is disabled", () => {
    withStorageDisabled(() => {
      const html = adminImageNewPage(OWNER_SESSION, "Upload failed");
      assertStringIncludes(html, "Upload failed");
      assertStringIncludes(html, "File storage is not configured.");
      assert(
        !html.includes('enctype="multipart/form-data"'),
        "the value should not contain the searched item",
      );
      assert(
        !html.includes('name="image"'),
        "the value should not contain the searched item",
      );
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

    assertStringIncludes(html, "Edit Poster");
    assertStringIncludes(html, '<div class="image-library-preview">');
    assertStringIncludes(html, 'value="Poster"');
    assertStringIncludes(html, "<strong>Linked items (1):</strong>");
    assertStringIncludes(
      html,
      '<li class="checkboxes"><strong>Listings:</strong>',
    );
    assertStringIncludes(
      html,
      '<li class="checkboxes"><strong>Groups:</strong>',
    );
    assertStringIncludes(html, 'value="listing:4"');
    assertStringIncludes(
      html,
      'checked name="image_items" type="checkbox" value="group:5"',
    );
    assertStringIncludes(html, '<a class="active" href="/admin/images">');
    assertStringIncludes(html, '<p class="prose">');
    assertStringIncludes(html, 'class="btn secondary"');
    assertStringIncludes(html, "/icons.svg#trash-2");
    assertStringIncludes(html, 'href="/admin/images/3/delete"');
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

    assertStringIncludes(html, '<li class="checkboxes"><strong>News:</strong>');
    assertStringIncludes(
      html,
      '<li class="checkboxes"><strong>Pages:</strong>',
    );
    assertStringIncludes(html, 'value="news:1"');
    assertStringIncludes(
      html,
      'checked name="image_items" type="checkbox" value="page:2"',
    );
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
    assert(
      !html.includes("Linked items"),
      "the value should not contain the searched item",
    );
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
    assertStringIncludes(html, "Delete Remove me");
    assertStringIncludes(html, "Nope");
    assertStringIncludes(html, 'action="/admin/images/2/delete"');
    assertStringIncludes(html, '<a class="active" href="/admin/images">');
    assertStringIncludes(html, '<button class="danger" type="submit">');
    assertStringIncludes(html, "Type the image name to confirm");
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
      assert(
        !html.includes("Current images"),
        "the value should not contain the searched item",
      );
      assert(
        !html.includes('action="/admin/listing/1/images"'),
        "the value should not contain the searched item",
      );
      assert(
        !html.includes('name="image_ids"'),
        "the value should not contain the searched item",
      );
      assert(
        !html.includes('type="file"'),
        "the value should not contain the searched item",
      );
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

      assertStringIncludes(html, "No images linked.");
      assertStringIncludes(html, "No images yet.");
      assertStringIncludes(html, 'enctype="multipart/form-data"');
      assertStringIncludes(html, 'name="image"');
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

      assertStringIncludes(
        html,
        '<fieldset class="checkboxes image-picker-checkboxes">',
      );
      assertStringIncludes(html, "/icons.svg#plus");
      const first = html.indexOf('name="image_ids" type="checkbox" value="1"');
      const second = html.indexOf('name="image_ids" type="checkbox" value="2"');
      const library = html.indexOf(
        'name="image_ids" type="checkbox" value="3"',
      );
      expect(first).toBeGreaterThan(-1);
      expect(second).toBeGreaterThan(first);
      expect(library).toBeGreaterThan(second);
    }));
});
