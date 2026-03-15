import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { decryptBytes, encryptBytes } from "#lib/crypto.ts";
import {
  ATTACHMENT_ERROR_MESSAGES,
  detectImageType,
  generateAttachmentFilename,
  generateImageFilename,
  getImageProxyUrl,
  getMimeTypeFromFilename,
  isStorageEnabled,
  MAX_ATTACHMENT_SIZE,
  validateAttachment,
  validateImage,
} from "#lib/storage.ts";

describe("storage", () => {
  beforeEach(() => {
    Deno.env.delete("STORAGE_ZONE_NAME");
    Deno.env.delete("STORAGE_ZONE_KEY");
  });

  afterEach(() => {
    Deno.env.delete("STORAGE_ZONE_NAME");
    Deno.env.delete("STORAGE_ZONE_KEY");
  });

  describe("isStorageEnabled", () => {
    test("returns false when neither env var is set", () => {
      expect(isStorageEnabled()).toBe(false);
    });

    test("returns false when only STORAGE_ZONE_NAME is set", () => {
      Deno.env.set("STORAGE_ZONE_NAME", "myzone");
      expect(isStorageEnabled()).toBe(false);
    });

    test("returns false when only STORAGE_ZONE_KEY is set", () => {
      Deno.env.set("STORAGE_ZONE_KEY", "mykey");
      expect(isStorageEnabled()).toBe(false);
    });

    test("returns true when both env vars are set", () => {
      Deno.env.set("STORAGE_ZONE_NAME", "myzone");
      Deno.env.set("STORAGE_ZONE_KEY", "mykey");
      expect(isStorageEnabled()).toBe(true);
    });
  });

  describe("getImageProxyUrl", () => {
    test("returns proxy path for filename", () => {
      expect(getImageProxyUrl("abc123.jpg")).toBe("/image/abc123.jpg");
    });
  });

  describe("getMimeTypeFromFilename", () => {
    test("returns MIME type for .jpg", () => {
      expect(getMimeTypeFromFilename("abc.jpg")).toBe("image/jpeg");
    });

    test("returns MIME type for .png", () => {
      expect(getMimeTypeFromFilename("abc.png")).toBe("image/png");
    });

    test("returns MIME type for .gif", () => {
      expect(getMimeTypeFromFilename("abc.gif")).toBe("image/gif");
    });

    test("returns MIME type for .webp", () => {
      expect(getMimeTypeFromFilename("abc.webp")).toBe("image/webp");
    });

    test("returns null for unknown extension", () => {
      expect(getMimeTypeFromFilename("abc.bmp")).toBeNull();
    });

    test("returns null for no extension", () => {
      expect(getMimeTypeFromFilename("abc")).toBeNull();
    });
  });

  describe("detectImageType", () => {
    test("detects JPEG from magic bytes", () => {
      const data = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
      expect(detectImageType(data)).toBe("image/jpeg");
    });

    test("detects PNG from magic bytes", () => {
      const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]);
      expect(detectImageType(data)).toBe("image/png");
    });

    test("detects GIF from magic bytes", () => {
      const data = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39]);
      expect(detectImageType(data)).toBe("image/gif");
    });

    test("detects WebP from magic bytes", () => {
      const data = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00]);
      expect(detectImageType(data)).toBe("image/webp");
    });

    test("returns null for unknown bytes", () => {
      const data = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      expect(detectImageType(data)).toBeNull();
    });

    test("returns null for empty data", () => {
      const data = new Uint8Array([]);
      expect(detectImageType(data)).toBeNull();
    });
  });

  describe("validateImage", () => {
    const jpegHeader = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    test("accepts valid JPEG image", () => {
      const result = validateImage(jpegHeader, "image/jpeg");
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.detectedType).toBe("image/jpeg");
      }
    });

    test("accepts valid PNG image", () => {
      const result = validateImage(pngHeader, "image/png");
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.detectedType).toBe("image/png");
      }
    });

    test("rejects image exceeding size limit", () => {
      const largeData = new Uint8Array(256 * 1024 + 1);
      largeData[0] = 0xff;
      largeData[1] = 0xd8;
      largeData[2] = 0xff;
      const result = validateImage(largeData, "image/jpeg");
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("too_large");
      }
    });

    test("rejects disallowed MIME type", () => {
      const result = validateImage(jpegHeader, "application/pdf");
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("invalid_type");
      }
    });

    test("rejects file with valid MIME but invalid magic bytes", () => {
      const fakeData = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      const result = validateImage(fakeData, "image/jpeg");
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("invalid_content");
      }
    });

    test("accepts image exactly at size limit", () => {
      const data = new Uint8Array(256 * 1024);
      data[0] = 0xff;
      data[1] = 0xd8;
      data[2] = 0xff;
      const result = validateImage(data, "image/jpeg");
      expect(result.valid).toBe(true);
    });
  });

  describe("generateImageFilename", () => {
    test("generates filename with .jpg extension for JPEG", () => {
      const filename = generateImageFilename("image/jpeg");
      expect(filename).toMatch(/^[0-9a-f-]+\.jpg$/);
    });

    test("generates filename with .png extension for PNG", () => {
      const filename = generateImageFilename("image/png");
      expect(filename).toMatch(/^[0-9a-f-]+\.png$/);
    });

    test("generates filename with .gif extension for GIF", () => {
      const filename = generateImageFilename("image/gif");
      expect(filename).toMatch(/^[0-9a-f-]+\.gif$/);
    });

    test("generates filename with .webp extension for WebP", () => {
      const filename = generateImageFilename("image/webp");
      expect(filename).toMatch(/^[0-9a-f-]+\.webp$/);
    });

    test("generates unique filenames", () => {
      const a = generateImageFilename("image/jpeg");
      const b = generateImageFilename("image/jpeg");
      expect(a).not.toBe(b);
    });
  });

  describe("allowed image types", () => {
    test("accepts the four supported types", () => {
      expect(
        validateImage(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg").valid,
      ).toBe(true);
      expect(
        validateImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png")
          .valid,
      ).toBe(true);
      expect(
        validateImage(new Uint8Array([0x47, 0x49, 0x46, 0x38]), "image/gif")
          .valid,
      ).toBe(true);
      expect(
        validateImage(new Uint8Array([0x52, 0x49, 0x46, 0x46]), "image/webp")
          .valid,
      ).toBe(true);
    });

    test("rejects unsupported types", () => {
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);
      expect(validateImage(jpeg, "image/svg+xml").valid).toBe(false);
      expect(validateImage(jpeg, "application/pdf").valid).toBe(false);
    });
  });

  describe("validateAttachment", () => {
    test("accepts file under 25MB", () => {
      const data = new Uint8Array(1024);
      const result = validateAttachment(data);
      expect(result.valid).toBe(true);
    });

    test("accepts file exactly at 25MB limit", () => {
      const data = new Uint8Array(MAX_ATTACHMENT_SIZE);
      const result = validateAttachment(data);
      expect(result.valid).toBe(true);
    });

    test("rejects file exceeding 25MB", () => {
      const data = new Uint8Array(MAX_ATTACHMENT_SIZE + 1);
      const result = validateAttachment(data);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe("too_large");
      }
    });

    test("accepts any file type (not just images)", () => {
      // PDF magic bytes - not a valid image, but attachments accept any type
      const data = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
      const result = validateAttachment(data);
      expect(result.valid).toBe(true);
    });
  });

  describe("ATTACHMENT_ERROR_MESSAGES", () => {
    test("has message for too_large error", () => {
      expect(ATTACHMENT_ERROR_MESSAGES.too_large).toBe(
        "Attachment exceeds the 25MB size limit",
      );
    });
  });

  describe("generateAttachmentFilename", () => {
    test("generates filename with UUID prefix and original name", () => {
      const filename = generateAttachmentFilename("report.pdf");
      expect(filename).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-report\.pdf$/,
      );
    });

    test("sanitizes special characters in filename", () => {
      const filename = generateAttachmentFilename("my file (1).pdf");
      // Spaces and parens should be replaced with underscores
      expect(filename).toMatch(/-my_file__1_\.pdf$/);
    });

    test("handles path separators in filename", () => {
      const filename = generateAttachmentFilename("/path/to/file.txt");
      // Only the basename should remain
      expect(filename).toMatch(/-file\.txt$/);
      expect(filename).not.toContain("/path");
    });

    test("generates unique filenames for same input", () => {
      const a = generateAttachmentFilename("doc.pdf");
      const b = generateAttachmentFilename("doc.pdf");
      expect(a).not.toBe(b);
    });

    test("preserves file extension", () => {
      const filename = generateAttachmentFilename("archive.tar.gz");
      expect(filename).toMatch(/\.tar\.gz$/);
    });
  });

  describe("encryptBytes / decryptBytes", () => {
    test("round-trips binary data through encrypt then decrypt", async () => {
      const original = new Uint8Array([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
      ]);
      const encrypted = await encryptBytes(original);
      // Encrypted data should be larger (12 byte IV + 16 byte auth tag)
      expect(encrypted.byteLength).toBeGreaterThan(original.byteLength);
      // Encrypted data should not start with original magic bytes
      expect(encrypted[0]).not.toBe(0xff);
      const decrypted = await decryptBytes(encrypted);
      expect(decrypted).toEqual(original);
    });

    test("produces different ciphertext for same input", async () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const a = await encryptBytes(data);
      const b = await encryptBytes(data);
      // Different IVs mean different ciphertext
      expect(a).not.toEqual(b);
      // But both decrypt to the same value
      expect(await decryptBytes(a)).toEqual(data);
      expect(await decryptBytes(b)).toEqual(data);
    });
  });
});
