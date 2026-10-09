/** Record-file cleanup pins, moved beside src/shared/storage-cleanup.ts with
 *  the sweeps and strict deletion they exercise. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  deleteAllImageStorageFiles,
  deleteAllListingAttachmentFiles,
  deleteImageStorageFilesStrict,
} from "#shared/storage-cleanup.ts";
import { setDeleteOverride } from "#shared/test-overrides.ts";
import { nonEmptyString } from "#shared/validation/string.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { withBunnyDeleteCapture } from "#test-utils/mocks.ts";
import { STORAGE_TEST_ENV } from "./storage/fixtures.ts";

const image = {
  filename: nonEmptyString("image.webp"),
  filename_thumb: nonEmptyString("image-thumb.webp"),
  id: 7,
};

const withDeleteError = async (
  error: Error,
  action: () => Promise<void>,
): Promise<void> => {
  setDeleteOverride(error);
  try {
    await action();
  } finally {
    setDeleteOverride(null);
  }
};

describeWithEnv("storage record cleanup", STORAGE_TEST_ENV, () => {
  describe("bulk deletion", () => {
    const errors = setupErrorSpy();

    test("deletes every non-empty listing attachment", async () => {
      await withBunnyDeleteCapture(async (deleted) => {
        await deleteAllListingAttachmentFiles([
          { attachment_url: "att1.pdf", id: 1 },
          { attachment_url: "", id: 2 },
          { attachment_url: "att3.pdf", id: 3 },
        ]);
        expect(deleted).toHaveLength(2);
        expect(deleted.some((url) => url.includes("att1.pdf"))).toBe(true);
        expect(deleted.some((url) => url.includes("att3.pdf"))).toBe(true);
      });
    });

    test("an empty listing attachment does not need storage config", async () => {
      await withBunnyDeleteCapture(
        async (deleted) => {
          await deleteAllListingAttachmentFiles([
            { attachment_url: "", id: 1 },
          ]);
          expect(deleted).toEqual([]);
        },
        { withConfig: false },
      );
    });

    test("continues after a listing attachment delete fails", async () => {
      await withBunnyDeleteCapture(
        async (deleted) => {
          await deleteAllListingAttachmentFiles([
            { attachment_url: "fail.pdf", id: 1 },
            { attachment_url: "succeed.pdf", id: 2 },
          ]);
          expect(deleted.some((url) => url.includes("succeed.pdf"))).toBe(true);
        },
        {
          extraHandler: (url) =>
            url.includes("fail.pdf")
              ? Promise.reject(new Error("CDN error"))
              : null,
        },
      );
    });

    test("labels listing reset deletion failures", async () => {
      await withDeleteError(new Error("delete failed"), () =>
        deleteAllListingAttachmentFiles([
          { attachment_url: "attachment.pdf", id: 1 },
        ]),
      );
      expect(errors.contains("database reset")).toBe(true);
    });

    test("deletes full and thumbnail files for every image", async () => {
      await withBunnyDeleteCapture(async (deleted) => {
        await deleteAllImageStorageFiles([
          image,
          {
            filename: nonEmptyString("other.webp"),
            filename_thumb: nonEmptyString("other-thumb.webp"),
            id: 8,
          },
        ]);
        expect(deleted).toHaveLength(4);
      });
    });

    test("labels image reset deletion failures", async () => {
      await withDeleteError(new Error("delete failed"), () =>
        deleteAllImageStorageFiles([image]),
      );
      expect(errors.contains("database reset")).toBe(true);
    });
  });

  describe("strict image deletion", () => {
    test("accepts an already missing file by message", async () => {
      await withDeleteError(
        new Error("File not found: image.webp"),
        async () => {
          await expect(
            deleteImageStorageFilesStrict(image),
          ).resolves.toBeUndefined();
        },
      );
    });

    test("accepts an already missing file by error name", async () => {
      const missing = new Error("already gone");
      missing.name = "NotFound";
      await withDeleteError(missing, async () => {
        await expect(
          deleteImageStorageFilesStrict(image),
        ).resolves.toBeUndefined();
      });
    });

    test("throws a genuine storage failure", async () => {
      await withDeleteError(new Error("delete failed"), async () => {
        await expect(deleteImageStorageFilesStrict(image)).rejects.toThrow(
          "delete failed",
        );
      });
    });
  });
});
