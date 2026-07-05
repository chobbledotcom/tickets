import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import type { AdminSession, Image } from "#shared/types.ts";
import { nonEmptyString } from "#shared/validation/string.ts";
import {
  adminImageDeletePage,
  adminImageEditPage,
  adminImageNewPage,
  adminImagesPage,
  ItemImagesPanel,
} from "#templates/admin/images.tsx";
import {
  setTestEnv,
  setupTestEncryptionKey,
  withStorageDisabled,
  withStorageEnabled,
} from "#test-utils";

const SESSION: AdminSession = { adminLevel: "owner" };

const image = (id: number, name: string): Image => ({
  alt_text: `Alt ${name}`,
  filename: nonEmptyString(`${name.toLowerCase()}.webp`),
  filename_thumb: nonEmptyString(`${name.toLowerCase()}-thumb.webp`),
  id,
  name,
});

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

describe("admin image templates", () => {
  test("renders the library table and hides edit actions in read-only mode", () => {
    const restore = setTestEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    try {
      const html = adminImagesPage([image(7, "Hero")], SESSION);
      expect(html).toContain("Hero");
      expect(html).toContain("/image/hero-thumb.webp");
      expect(html).not.toContain('href="/admin/images/7/edit"');
      expect(html).not.toContain('href="/admin/images/new"');
    } finally {
      restore();
    }
  });

  test("renders the thumbnail from the image thumbnail filename", () => {
    const html = adminImagesPage([image(8, "Poster")], SESSION);
    expect(html).toContain("/image/poster-thumb.webp");
    expect(html).not.toContain("/image/poster.webp");
  });

  test("renders the new image upload form", () => {
    const html = adminImageNewPage(SESSION, "Upload failed");
    expect(html).toContain("Upload failed");
    expect(html).toContain('action="/admin/images"');
    expect(html).toContain('enctype="multipart/form-data"');
    expect(html).toContain('name="image"');
  });

  test("renders edit fields, linked item checkboxes, and delete action", () => {
    const html = adminImageEditPage({
      image: image(3, "Poster"),
      options: [
        { id: 4, label: "Listing A", type: "listing" },
        { id: 5, label: "Group B", type: "group" },
      ],
      selected: new Set(["group:5"]),
      session: SESSION,
    });

    expect(html).toContain("Edit Poster");
    expect(html).toContain('value="Poster"');
    expect(html).toContain('value="listing:4"');
    expect(html).toContain(
      'checked name="image_items" type="checkbox" value="group:5"',
    );
    expect(html).toContain('href="/admin/images/3/delete"');
  });

  test("renders edit empty linked-item state", () => {
    const html = adminImageEditPage({
      image: image(9, "Unlinked"),
      options: [],
      selected: new Set(),
      session: SESSION,
    });
    expect(html).toContain("No listings or groups yet.");
  });

  test("renders the delete confirmation page", () => {
    const html = adminImageDeletePage(image(2, "Remove me"), SESSION, "Nope");
    expect(html).toContain("Delete Remove me");
    expect(html).toContain("Nope");
    expect(html).toContain('action="/admin/images/2/delete"');
    expect(html).toContain("Type the image name to confirm");
  });

  test("renders item image selection and storage-disabled upload state", () =>
    withStorageDisabled(() => {
      const html = String(
        ItemImagesPanel({
          action: "/admin/listing/1/images",
          allImages: [image(1, "Current"), image(2, "Other")],
          linkedImages: [image(1, "Current")],
          uploadAction: "/admin/listing/1/images/upload",
        }),
      );

      expect(html).toContain("Current images");
      expect(html).toContain('action="/admin/listing/1/images"');
      expect(html).toContain(
        'checked name="image_ids" type="checkbox" value="1"',
      );
      expect(html).toContain('value="2"');
      expect(html).toContain("File storage is not configured.");
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
});
