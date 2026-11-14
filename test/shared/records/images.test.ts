/**
 * The image record: its metadata rule, its upload boundary, and its write
 * commands, called directly against the test database.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  deleteImageRecord,
  getImageById,
  getImagesForItem,
} from "#db/images.ts";
import {
  imageMetadata,
  imageMetadataOrError,
  imageRecord,
  insertUploadedImage,
  uploadImageFiles,
} from "#shared/records/images.ts";
import { nonEmptyString } from "#shared/validation/string.ts";
import {
  imageOnListing,
  imageOnListingAndGroup,
  loggedMessages,
  makeImage,
} from "#test-utils/admin-images.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { pathExists } from "#test-utils/files.ts";
import { getTestStoragePath } from "#test-utils/internal.ts";
import {
  withCdnRejecting,
  withExpectedError,
  withStorageDisabled,
} from "#test-utils/mocks.ts";
import { deleteConfirmLabel } from "#test-utils/record-labels.ts";
import { beforeNextTransaction } from "#test-utils/record-queries.ts";
import { makeTestPng } from "#test-utils/test-image.ts";

/** Whether the local storage folder still holds one stored file. */
const storedFileExists = (filename: string): Promise<boolean> =>
  pathExists(`${getTestStoragePath()}/${filename}`);

const imageInput = {
  altText: "A cat",
  filename: nonEmptyString("cat.webp"),
  filenameThumb: nonEmptyString("cat-thumb.webp"),
  name: "Cat",
};

const LONG = "x".repeat(251);
const LIMIT = "x".repeat(250);

describe("the image metadata rule", () => {
  test("trims the name and alt text it stores", () => {
    expect(imageMetadata("  Cat photo  ", "  A cat  ")).toEqual({
      ok: true,
      value: { altText: "A cat", name: "Cat photo" },
    });
  });

  test("refuses a name with nothing in it", () => {
    expect(imageMetadata("   ", "A cat")).toEqual({
      error: "Image name is required",
      ok: false,
    });
  });

  test("refuses a name past the text box limit", () => {
    expect(imageMetadata(LONG, "")).toEqual({
      error: "Image name must be 250 characters or fewer",
      ok: false,
    });
  });

  test("refuses alt text past the text box limit", () => {
    expect(imageMetadata("Cat", LONG)).toEqual({
      error: "Alt text must be 250 characters or fewer",
      ok: false,
    });
  });

  test("accepts a name and alt text at the limit", () => {
    expect(imageMetadata(LIMIT, LIMIT)).toEqual({
      ok: true,
      value: { altText: LIMIT, name: LIMIT },
    });
  });

  test("answers the same refusal through the shared door", () => {
    expect(imageMetadataOrError("", "")).toEqual({
      error: "Image name is required",
      ok: false,
    });
    expect(imageMetadataOrError(" Cat ", "")).toEqual({
      ok: true,
      value: { altText: "", name: "Cat" },
    });
  });
});

describe("the image record's rule", () => {
  test("trims the name and alt text it stores", () => {
    expect(
      imageRecord.rule(
        { ...imageInput, altText: "  A cat  ", name: "  Cat photo  " },
        null,
      ),
    ).toEqual({
      ok: true,
      value: { ...imageInput, altText: "A cat", name: "Cat photo" },
    });
  });

  test("reads absent alt text as empty", () => {
    const { altText: _altText, ...noAlt } = imageInput;

    expect(imageRecord.rule(noAlt, null)).toEqual({
      ok: true,
      value: { ...noAlt, altText: "", name: "Cat" },
    });
  });

  test("refuses a name with nothing in it", () => {
    expect(imageRecord.rule({ ...imageInput, name: "   " }, null)).toEqual({
      error: "Image name is required",
      ok: false,
    });
  });
});

describe("the image record's declaration", () => {
  test("asks for the image name on its delete page", () => {
    expect(imageRecord.activityName).toBe("Image");
    expect(deleteConfirmLabel(imageRecord)).toBe(
      "Type the image name to confirm",
    );
  });
});

describeWithEnv(
  "the image upload boundary",
  { db: true, storage: "local" },
  () => {
    test("refuses an upload while file storage is off", async () => {
      const bytes = await makeTestPng(2, 2);

      expect(
        await withStorageDisabled(() =>
          uploadImageFiles({ bytes, contentType: "image/png" }),
        ),
      ).toEqual({ error: "File storage is not configured.", ok: false });
    });

    test("refuses a file that is not an image", async () => {
      expect(
        await uploadImageFiles({
          bytes: new TextEncoder().encode("not an image"),
          contentType: "image/png",
        }),
      ).toEqual({
        error: "File does not appear to be a valid image",
        ok: false,
      });
    });

    test("stores the full image and its thumbnail under two names", async () => {
      const uploaded = await uploadImageFiles({
        bytes: await makeTestPng(4, 4),
        contentType: "image/png",
      });
      if (!uploaded.ok) throw new Error(uploaded.error);
      const { filename, filenameThumb } = uploaded.value;

      expect([
        filename.endsWith(".webp"),
        filenameThumb.endsWith(".webp"),
        filename === filenameThumb,
        await storedFileExists(filename),
        await storedFileExists(filenameThumb),
      ]).toEqual([true, true, false, true, true]);
    });

    test("removes both stored files when the image insert fails", async () => {
      const uploaded = await uploadImageFiles({
        bytes: await makeTestPng(4, 4),
        contentType: "image/png",
      });
      if (!uploaded.ok) throw new Error(uploaded.error);
      const { filename, filenameThumb } = uploaded.value;
      const restore = beforeNextTransaction(() =>
        Promise.reject(new Error("insert down")),
      );
      try {
        await expect(
          insertUploadedImage({
            altText: "",
            filename,
            filenameThumb,
            name: "Lost",
          }),
        ).rejects.toThrow("insert down");
      } finally {
        restore();
      }
      expect([
        await storedFileExists(filename),
        await storedFileExists(filenameThumb),
      ]).toEqual([false, false]);
    });
  },
);

describeWithEnv(
  "the image storage failures",
  { db: true, storage: "cdn" },
  () => {
    const errors = setupErrorSpy();

    test("answers a failed upload with its cause and logs it", async () => {
      const bytes = await makeTestPng(4, 4);

      await withExpectedError(() =>
        withCdnRejecting(new Error("upload down"), async () => {
          expect(
            await uploadImageFiles({ bytes, contentType: "image/png" }),
          ).toEqual({
            error: "Image upload failed: Error: upload down",
            ok: false,
          });
        }),
      );
      expect(
        errors.contains('detail="Image upload failed: Error: upload down"'),
      ).toBe(true);
    });

    test("logs each file it cannot remove after a failed insert", async () => {
      const restore = beforeNextTransaction(() =>
        Promise.reject(new Error("insert down")),
      );
      try {
        await withExpectedError(() =>
          withCdnRejecting(new Error("delete down"), async () => {
            await expect(insertUploadedImage(imageInput)).rejects.toThrow(
              "insert down",
            );
          }),
        );
      } finally {
        restore();
      }
      expect([
        errors.contains('detail="failed image record cleanup"'),
        errors.contains('detail="failed image thumbnail record cleanup"'),
      ]).toEqual([true, true]);
    });
  },
);

describeWithEnv("the image record's commands", { db: true }, () => {
  test("creates an image from uploaded files and logs the upload", async () => {
    expect(
      await imageRecord.create({ ...imageInput, name: "  Cat  " }),
    ).toMatchObject({
      kind: "written",
      row: { alt_text: "A cat", filename: "cat.webp", id: 1, name: "Cat" },
    });
    expect(await loggedMessages()).toEqual(["Image 'Cat' uploaded"]);
  });

  test("refuses to create an image whose name is empty", async () => {
    expect(await imageRecord.create({ ...imageInput, name: "" })).toEqual({
      kind: "refused",
      message: "Image name is required",
    });
    expect(await imageRecord.getAll()).toEqual([]);
  });

  test("lists the images by name", async () => {
    await makeImage("Zebra");
    await makeImage("Ant");

    expect((await imageRecord.getAll()).map((image) => image.name)).toEqual([
      "Ant",
      "Zebra",
    ]);
  });

  test("updates the name and alt text and logs it", async () => {
    const image = await makeImage("Before");

    expect(
      await imageRecord.update(image.id, {
        ...imageInput,
        altText: "New alt",
        name: "After",
      }),
    ).toMatchObject({
      kind: "written",
      row: { alt_text: "New alt", id: image.id, name: "After" },
    });
    expect(await loggedMessages()).toEqual(["Image 'After' updated"]);
  });

  test("keeps the stored links when an update carries no link list", async () => {
    const { image, listingId } = await imageOnListing("Linked");

    await imageRecord.update(image.id, {
      ...imageInput,
      items: null,
      name: "Linked",
    });

    expect(
      (await getImagesForItem("listing", listingId)).map((row) => row.id),
    ).toEqual([image.id]);
  });

  test("replaces the stored links with the list an update carries", async () => {
    const { group, image, listing } = await imageOnListingAndGroup(
      "Moved",
      "Summer",
      "Club",
    );

    await imageRecord.update(image.id, {
      ...imageInput,
      items: [{ id: group.id, kind: "group" }],
      name: "Moved",
    });

    expect([
      (await getImagesForItem("listing", listing.id)).map((row) => row.id),
      (await getImagesForItem("group", group.id)).map((row) => row.id),
    ]).toEqual([[], [image.id]]);
  });

  test("refuses links to missing records and keeps the image as it was", async () => {
    const image = await makeImage("Kept");
    const listing = await createTestListing({ name: "Real" });

    expect(
      await imageRecord.update(image.id, {
        ...imageInput,
        items: [
          { id: listing.id, kind: "listing" },
          { id: 98, kind: "listing" },
          { id: 99, kind: "group" },
        ],
        name: "Changed",
      }),
    ).toEqual({
      kind: "refused",
      message: "items must name existing records: listing:98, group:99",
    });
    expect((await getImageById(image.id))?.name).toBe("Kept");
    expect(await loggedMessages()).toEqual(["Listing 'Real' created"]);
  });

  test("refuses an update whose name is empty", async () => {
    const image = await makeImage("Named");

    expect(
      await imageRecord.update(image.id, { ...imageInput, name: " " }),
    ).toEqual({ kind: "refused", message: "Image name is required" });
  });

  test("answers not-found for an update of a missing image", async () => {
    expect(await imageRecord.update(99, imageInput)).toEqual({
      kind: "not-found",
    });
  });

  test("answers not-found when the image is deleted before the write", async () => {
    const image = await makeImage("Vanishing");
    const restore = beforeNextTransaction(() => deleteImageRecord(image.id));
    try {
      expect(
        await imageRecord.update(image.id, {
          filename: image.filename,
          filenameThumb: image.filename_thumb,
          name: "Gone",
        }),
      ).toEqual({ kind: "not-found" });
    } finally {
      restore();
    }
    expect(await loggedMessages()).toEqual([]);
  });

  test("deletes an image and logs it with the image name", async () => {
    const image = await makeImage("Old");

    expect(await imageRecord.remove(image.id)).toEqual({ kind: "deleted" });
    expect(await getImageById(image.id)).toBe(null);
    expect(await loggedMessages()).toEqual(["Image 'Old' deleted"]);
  });
});
