import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { Image } from "#shared/types.ts";
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
      expect(html).toContain("Hero");
      expect(html).toContain("/image/hero-thumb.webp");
      expect(html).not.toContain('href="/admin/images/7/edit"');
      expect(html).not.toContain('href="/admin/images/new"');
    });
  });

  test("renders the thumbnail from the image thumbnail filename", () => {
    withStorageEnabled(() => {
      const html = adminImagesPage([image(8, "Poster")], OWNER_SESSION);
      expect(html).toContain(
        '<img alt="Alt Poster" class="image-library-thumb" src="/image/poster-thumb.webp">',
      );
      expect(html).not.toContain("/image/poster.webp");
      expect(html).toContain('<a class="active" href="/admin/images">');
    });
  });

  test("renders the empty-library message when there are no images", () => {
    withStorageEnabled(() => {
      const html = adminImagesPage([], OWNER_SESSION);
      expect(html).toContain("No images yet.");
    });
  });

  test("hides the image library table and actions when storage is disabled", () => {
    withStorageDisabled(() => {
      const html = adminImagesPage([image(8, "Poster")], OWNER_SESSION);
      expect(html).toContain(
        '<p class="notice">File storage is not configured.</p>',
      );
      expect(html).not.toContain('href="/admin/images/new"');
      expect(html).not.toContain("/image/poster-thumb.webp");
      expect(html).not.toContain("Poster");
    });
  });

  test("renders the new image upload form", () => {
    withStorageEnabled(() => {
      const html = adminImageNewPage(OWNER_SESSION, "Upload failed");
      expect(html).toContain("Upload failed");
      expect(html).toContain('action="/admin/images"');
      expect(html).toContain('enctype="multipart/form-data"');
      expect(html).toContain('<a class="active" href="/admin/images">');
      expect(html).toContain('<input name="name" required type="text">');
      expect(html).toContain('<input name="alt_text" type="text">');
      expect(html).toContain(
        '<input accept="image/jpeg,image/png,image/webp" name="image" type="file">',
      );
      expect(html).toContain("/icons.svg#save");
    });
  });

  test("renders the new image disabled state when storage is disabled", () => {
    withStorageDisabled(() => {
      const html = adminImageNewPage(OWNER_SESSION, "Upload failed");
      expect(html).toContain("Upload failed");
      expect(html).toContain("File storage is not configured.");
      expect(html).not.toContain('enctype="multipart/form-data"');
      expect(html).not.toContain('name="image"');
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

    expect(html).toContain("Edit Poster");
    expect(html).toContain('<div class="image-library-preview">');
    expect(html).toContain('value="Poster"');
    expect(html).toContain("<strong>Linked items (1):</strong>");
    expect(html).toContain('<li class="checkboxes"><strong>Listings:</strong>');
    expect(html).toContain('<li class="checkboxes"><strong>Groups:</strong>');
    expect(html).toContain('value="listing:4"');
    expect(html).toContain(
      'checked name="image_items" type="checkbox" value="group:5"',
    );
    expect(html).toContain('<a class="active" href="/admin/images">');
    expect(html).toContain('<p class="prose">');
    expect(html).toContain('class="btn secondary"');
    expect(html).toContain("/icons.svg#trash-2");
    expect(html).toContain('href="/admin/images/3/delete"');
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

    expect(html).toContain('<li class="checkboxes"><strong>News:</strong>');
    expect(html).toContain('<li class="checkboxes"><strong>Pages:</strong>');
    expect(html).toContain('value="news:1"');
    expect(html).toContain(
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

    expect(html).toContain("<strong>Linked listings (1):</strong>");
    expect(html).not.toContain("Linked items");
    const active = html.indexOf('value="listing:4"');
    const retired = html.indexOf('value="listing:7"');
    expect(active).toBeGreaterThan(-1);
    expect(retired).toBeGreaterThan(active);
    expect(html).toContain(
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
    expect(html).toContain("No listings or groups yet.");
  });

  test("renders the delete confirmation page", () => {
    const html = withStorageEnabled(() =>
      adminImageDeletePage(image(2, "Remove me"), OWNER_SESSION, "Nope"),
    );
    expect(html).toContain("Delete Remove me");
    expect(html).toContain("Nope");
    expect(html).toContain('action="/admin/images/2/delete"');
    expect(html).toContain('<a class="active" href="/admin/images">');
    expect(html).toContain('<button class="danger" type="submit">');
    expect(html).toContain("Type the image name to confirm");
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

      expect(html).toContain("File storage is not configured.");
      expect(html).not.toContain("Current images");
      expect(html).not.toContain('action="/admin/listing/1/images"');
      expect(html).not.toContain('name="image_ids"');
      expect(html).not.toContain('type="file"');
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

      expect(html).toContain("No images linked.");
      expect(html).toContain("No images yet.");
      expect(html).toContain('enctype="multipart/form-data"');
      expect(html).toContain('name="image"');
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

      expect(html).toContain(
        '<fieldset class="checkboxes image-picker-checkboxes">',
      );
      expect(html).toContain("/icons.svg#plus");
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
