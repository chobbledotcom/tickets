import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FULL_IMAGE_TARGET } from "#shared/images/targets.ts";
import { MAX_IMAGE_SIZE } from "#shared/limits.ts";
import {
  deleteFile,
  detectImageType,
  downloadImage,
  getMimeTypeFromFilename,
  IMAGE_ERROR_MESSAGES,
  uploadImageTargets,
  validateImage,
} from "#shared/storage.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withLocalStorageEnabled } from "#test-utils/mocks.ts";
import { expectWebpContainer, makeTestPng } from "#test-utils/test-image.ts";
import { STORAGE_TEST_ENV } from "./fixtures.ts";

describeWithEnv("image storage", STORAGE_TEST_ENV, () => {
  test("transcodes an upload to an encrypted WebP file", async () => {
    await withLocalStorageEnabled(async (dir) => {
      const png = await makeTestPng(120, 90);
      const [filename] = await uploadImageTargets(png, "image/png", [
        FULL_IMAGE_TARGET,
      ]);
      expect(filename).toMatch(/^[0-9a-f-]+\.webp$/);
      const stat = await Deno.stat(`${dir}/${filename}`);
      expect(stat.isFile).toBe(true);
      expect(stat.size).toBeGreaterThan(0);
    });
  });

  test("downloadImage decrypts a stored WebP variant", async () => {
    await withLocalStorageEnabled(async () => {
      const png = await makeTestPng(120, 90);
      const [filename] = await uploadImageTargets(png, "image/png", [
        FULL_IMAGE_TARGET,
      ]);
      const result = await downloadImage(filename as string);
      expect(result).not.toBeNull();
      expectWebpContainer(result as Uint8Array);
    });
  });

  test("downloadImage returns null for a missing file", async () => {
    await withLocalStorageEnabled(async () => {
      expect(await downloadImage("nonexistent.webp")).toBeNull();
    });
  });

  test("downloadImage rethrows unexpected filesystem errors", async () => {
    await withLocalStorageEnabled(async (dir) => {
      const filename = "collision.jpg";
      await Deno.mkdir(`${dir}/${filename}`);
      await expect(downloadImage(filename)).rejects.toBeInstanceOf(Error);
    });
  });

  test("deleteFile removes a stored WebP variant", async () => {
    await withLocalStorageEnabled(async (dir) => {
      const png = await makeTestPng(64, 48);
      const [filename] = await uploadImageTargets(png, "image/png", [
        FULL_IMAGE_TARGET,
      ]);
      await deleteFile(filename as string);
      await expect(Deno.stat(`${dir}/${filename}`)).rejects.toBeInstanceOf(
        Deno.errors.NotFound,
      );
    });
  });

  describe("image paths and MIME types", () => {
    test("maps every stored image extension", () => {
      expect(getMimeTypeFromFilename("a.jpg")).toBe("image/jpeg");
      expect(getMimeTypeFromFilename("abc.png")).toBe("image/png");
      expect(getMimeTypeFromFilename("abc.gif")).toBe("image/gif");
      expect(getMimeTypeFromFilename("abc.webp")).toBe("image/webp");
    });

    test("returns null for an unknown extension", () => {
      expect(getMimeTypeFromFilename("abc.bmp")).toBeNull();
    });

    test("returns null when there is no extension", () => {
      expect(getMimeTypeFromFilename("abc")).toBeNull();
    });
  });

  describe("image type detection", () => {
    test("detects JPEG", () => {
      expect(detectImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(
        "image/jpeg",
      );
    });

    test("detects PNG", () => {
      expect(detectImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(
        "image/png",
      );
    });

    test("detects GIF", () => {
      expect(detectImageType(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe(
        "image/gif",
      );
    });

    test("detects WebP", () => {
      expect(
        detectImageType(
          new Uint8Array([
            0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
          ]),
        ),
      ).toBe("image/webp");
    });

    test("rejects a non-WebP RIFF container", () => {
      expect(
        detectImageType(
          new Uint8Array([
            0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
          ]),
        ),
      ).toBeNull();
    });

    test("rejects unknown and empty data", () => {
      expect(detectImageType(new Uint8Array([0, 1, 2, 3]))).toBeNull();
      expect(detectImageType(new Uint8Array())).toBeNull();
    });
  });

  describe("image validation", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    test("accepts supported image data", () => {
      expect(validateImage(jpeg, "image/jpeg")).toEqual({
        detectedType: "image/jpeg",
        valid: true,
      });
      expect(validateImage(png, "image/png")).toEqual({
        detectedType: "image/png",
        valid: true,
      });
    });

    test("accepts an image exactly at the size limit", () => {
      const data = new Uint8Array(MAX_IMAGE_SIZE);
      data.set(jpeg);
      expect(validateImage(data, "image/jpeg").valid).toBe(true);
    });

    test("rejects an image over the size limit", () => {
      const data = new Uint8Array(MAX_IMAGE_SIZE + 1);
      data.set(jpeg);
      expect(validateImage(data, "image/jpeg")).toEqual({
        error: "too_large",
        valid: false,
      });
    });

    test("rejects a disallowed declared MIME type", () => {
      expect(validateImage(jpeg, "application/pdf")).toEqual({
        error: "invalid_type",
        valid: false,
      });
    });

    test("rejects invalid image content", () => {
      expect(validateImage(new Uint8Array([0, 1, 2, 3]), "image/jpeg")).toEqual(
        { error: "invalid_content", valid: false },
      );
    });

    test("rejects a GIF even when declared as PNG", () => {
      const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38]);
      expect(validateImage(gif, "image/png")).toEqual({
        error: "invalid_content",
        valid: false,
      });
    });

    test("provides exact validation messages", () => {
      expect(IMAGE_ERROR_MESSAGES.invalid_content).toBe(
        "File does not appear to be a valid image",
      );
      expect(IMAGE_ERROR_MESSAGES.invalid_type).toBe(
        "Image must be a JPEG, PNG, or WebP file",
      );
      expect(IMAGE_ERROR_MESSAGES.too_large).toBe(
        "Image exceeds the 32MB size limit",
      );
    });
  });
});
