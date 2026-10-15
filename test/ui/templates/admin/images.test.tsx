import { assert } from "@std/assert";
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
import { says } from "#test-utils/says.ts";
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
      says(html, "Hero");
      says(html, "/image/hero-thumb.webp");
      assert(!html.includes('href="/admin/images/7/edit"'));
      assert(!html.includes('href="/admin/images/new"'));
    });
  });

  test("renders the thumbnail from the image thumbnail filename", () => {
    withStorageEnabled(() => {
      const html = adminImagesPage([image(8, "Poster")], OWNER_SESSION);
      says(
        html,
        '<img alt="Alt Poster" class="image-library-thumb" src="/image/poster-thumb.webp">',
      );
      assert(!html.includes("/image/poster.webp"));
      says(html, '<a class="active" href="/admin/images">');
    });
  });

  test("renders the empty-library message when there are no images", () => {
    withStorageEnabled(() => {
      const html = adminImagesPage([], OWNER_SESSION);
      says(html, "No images yet.");
    });
  });

  test("hides the image library table and actions when storage is disabled", () => {
    withStorageDisabled(() => {
      const html = adminImagesPage([image(8, "Poster")], OWNER_SESSION);
      says(html, '<p class="notice">File storage is not configured.</p>');
      assert(!html.includes('href="/admin/images/new"'));
      assert(!html.includes("/image/poster-thumb.webp"));
      assert(!html.includes("Poster"));
    });
  });

  test("renders the new image upload form", () => {
    withStorageEnabled(() => {
      const html = adminImageNewPage(OWNER_SESSION, "Upload failed");
      says(html, "Upload failed");
      says(html, 'action="/admin/images"');
      says(html, 'enctype="multipart/form-data"');
      says(html, '<a class="active" href="/admin/images">');
      says(html, '<input maxlength="250" name="name" required type="text">');
      says(html, '<input maxlength="250" name="alt_text" type="text">');
      says(
        html,
        '<input accept="image/jpeg,image/png,image/webp" name="image" type="file">',
      );
      says(html, "/icons.svg#save");
    });
  });

  test("renders the new image disabled state when storage is disabled", () => {
    withStorageDisabled(() => {
      const html = adminImageNewPage(OWNER_SESSION, "Upload failed");
      says(html, "Upload failed");
      says(html, "File storage is not configured.");
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

    says(html, "Edit Poster");
    says(html, '<div class="image-library-preview">');
    says(html, 'value="Poster"');
    says(html, "<strong>Linked items (1):</strong>");
    says(html, '<li class="checkboxes"><strong>Listings:</strong>');
    says(html, '<li class="checkboxes"><strong>Groups:</strong>');
    says(html, 'value="listing:4"');
    says(html, 'checked name="image_items" type="checkbox" value="group:5"');
    says(html, '<a class="active" href="/admin/images">');
    says(html, '<p class="prose">');
    says(html, 'class="btn secondary"');
    says(html, "/icons.svg#trash-2");
    says(html, 'href="/admin/images/3/delete"');
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

    says(html, '<li class="checkboxes"><strong>News:</strong>');
    says(html, '<li class="checkboxes"><strong>Pages:</strong>');
    says(html, 'value="news:1"');
    says(html, 'checked name="image_items" type="checkbox" value="page:2"');
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

    says(html, "<strong>Linked listings (1):</strong>");
    assert(!html.includes("Linked items"));
    const active = html.indexOf('value="listing:4"');
    const retired = html.indexOf('value="listing:7"');
    expect(active).toBeGreaterThan(-1);
    expect(retired).toBeGreaterThan(active);
    says(
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
    says(html, "No listings or groups yet.");
  });

  test("renders the delete confirmation page", () => {
    const html = withStorageEnabled(() =>
      adminImageDeletePage(image(2, "Remove me"), OWNER_SESSION, "Nope"),
    );
    says(html, "Delete Remove me");
    says(html, "Nope");
    says(html, 'action="/admin/images/2/delete"');
    says(html, '<a class="active" href="/admin/images">');
    says(html, '<button class="danger" type="submit">');
    says(html, "Type the image name to confirm");
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

      says(html, "File storage is not configured.");
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

      says(html, "No images linked.");
      says(html, "No images yet.");
      says(html, 'enctype="multipart/form-data"');
      says(html, 'name="image"');
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

      says(html, '<fieldset class="checkboxes image-picker-checkboxes">');
      says(html, "/icons.svg#plus");
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
