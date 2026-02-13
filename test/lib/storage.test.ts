import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import {
  detectImageType,
  formatImageError,
  generateImageFilename,
  getImageProxyUrl,
  getMimeTypeFromFilename,
  isStorageEnabled,
  validateImage,
} from "#lib/storage.ts";
import { decryptBytes, encryptBytes } from "#lib/crypto.ts";

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
      const data = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00]);
      expect(detectImageType(data)).toBe("image/jpeg");
    });

    test("detects PNG from magic bytes", () => {
      const data = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D]);
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
    const jpegHeader = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]);
    const pngHeader = new Uint8Array([0x89, 0x50, 0x4E, 0x47]);

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
      largeData[0] = 0xFF;
      largeData[1] = 0xD8;
      largeData[2] = 0xFF;
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
      data[0] = 0xFF;
      data[1] = 0xD8;
      data[2] = 0xFF;
      const result = validateImage(data, "image/jpeg");
      expect(result.valid).toBe(true);
    });
  });

  describe("formatImageError", () => {
    test("formats too_large error", () => {
      expect(formatImageError("too_large")).toBe("Image must be less than 256KB");
    });

    test("formats invalid_type error", () => {
      expect(formatImageError("invalid_type")).toBe("Only JPEG, PNG, GIF, and WebP images are allowed");
    });

    test("formats invalid_content error", () => {
      expect(formatImageError("invalid_content")).toBe("File does not appear to be a valid image");
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
      expect(validateImage(new Uint8Array([0xFF, 0xD8, 0xFF]), "image/jpeg").valid).toBe(true);
      expect(validateImage(new Uint8Array([0x89, 0x50, 0x4E, 0x47]), "image/png").valid).toBe(true);
      expect(validateImage(new Uint8Array([0x47, 0x49, 0x46, 0x38]), "image/gif").valid).toBe(true);
      expect(validateImage(new Uint8Array([0x52, 0x49, 0x46, 0x46]), "image/webp").valid).toBe(true);
    });

    test("rejects unsupported types", () => {
      const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF]);
      expect(validateImage(jpeg, "image/svg+xml").valid).toBe(false);
      expect(validateImage(jpeg, "application/pdf").valid).toBe(false);
    });
  });

  describe("encryptBytes / decryptBytes", () => {
    test("round-trips binary data through encrypt then decrypt", async () => {
      const original = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]);
      const encrypted = await encryptBytes(original);
      // Encrypted data should be larger (12 byte IV + 16 byte auth tag)
      expect(encrypted.byteLength).toBeGreaterThan(original.byteLength);
      // Encrypted data should not start with original magic bytes
      expect(encrypted[0]).not.toBe(0xFF);
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
