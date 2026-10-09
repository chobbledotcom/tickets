import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  ATTACHMENT_ERROR_MESSAGES,
  deleteFile,
  generateAttachmentFilename,
  MAX_ATTACHMENT_SIZE,
  validateAttachment,
} from "#shared/storage.ts";
import { setDeleteOverride } from "#shared/test-overrides.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  withLocalStorageEnabled,
  withStorageDisabled,
} from "#test-utils/mocks.ts";
import { STORAGE_TEST_ENV } from "./fixtures.ts";

describeWithEnv("attachment storage", STORAGE_TEST_ENV, () => {
  describe("validation and filenames", () => {
    test("accepts files through the attachment size limit", () => {
      expect(validateAttachment(new Uint8Array(1024))).toEqual({ valid: true });
      expect(validateAttachment(new Uint8Array(MAX_ATTACHMENT_SIZE))).toEqual({
        valid: true,
      });
    });

    test("rejects files over the attachment size limit", () => {
      expect(
        validateAttachment(new Uint8Array(MAX_ATTACHMENT_SIZE + 1)),
      ).toEqual({ error: "too_large", valid: false });
    });

    test("provides the exact size error", () => {
      expect(ATTACHMENT_ERROR_MESSAGES.too_large).toBe(
        "Attachment exceeds the 25MB size limit",
      );
    });

    test("generates a UUID-prefixed readable filename", () => {
      const filename = generateAttachmentFilename("report.pdf");
      expect(v.is(v.pipe(v.string(), v.uuid()), filename.slice(0, 36))).toBe(
        true,
      );
      expect(filename.slice(36)).toBe("-report.pdf");
    });

    test("sanitizes special characters", () => {
      expect(generateAttachmentFilename("my file (1).pdf")).toMatch(
        /-my_file__1_\.pdf$/,
      );
    });

    test("strips forward and backslash paths", () => {
      expect(generateAttachmentFilename("/path/to/file.txt")).toMatch(
        /-file\.txt$/,
      );
      expect(generateAttachmentFilename("C:\\Users\\docs\\file.txt")).toMatch(
        /-file\.txt$/,
      );
    });

    test("uses file when no basename remains", () => {
      expect(generateAttachmentFilename("/")).toMatch(/-file$/);
    });

    test("generates unique names for the same input", () => {
      expect(generateAttachmentFilename("doc.pdf")).not.toBe(
        generateAttachmentFilename("doc.pdf"),
      );
    });

    test("preserves compound extensions", () => {
      expect(generateAttachmentFilename("archive.tar.gz")).toMatch(
        /\.tar\.gz$/,
      );
    });
  });

  describe("deleteFile", () => {
    test("throws when storage is not configured", async () => {
      await withStorageDisabled(async () => {
        await expect(deleteFile("test.jpg")).rejects.toThrow(
          "Storage is not configured",
        );
      });
    });

    test("throws an override before touching storage", async () => {
      await withLocalStorageEnabled(async () => {
        setDeleteOverride(new Error("forced delete failure"));
        try {
          await expect(deleteFile("any-file.jpg")).rejects.toThrow(
            "forced delete failure",
          );
        } finally {
          setDeleteOverride(null);
        }
      });
    });
  });
});
