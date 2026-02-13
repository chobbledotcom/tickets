/**
 * Bunny CDN storage integration for event images.
 * Uses @bunny.net/storage-sdk to upload/delete images.
 * Only enabled when STORAGE_ZONE_NAME and STORAGE_ZONE_KEY env vars are set.
 * Images are encrypted with DB_ENCRYPTION_KEY before upload.
 */

import * as BunnyStorageSDK from "@bunny.net/storage-sdk";
import { decryptBytes, encryptBytes } from "#lib/crypto.ts";
import { getEnv } from "#lib/env.ts";

/** Maximum image file size in bytes (256KB) */
const MAX_IMAGE_SIZE = 256 * 1024;

/** Supported image types — single source of truth for mime, extension, and magic bytes */
const IMAGE_TYPES = [
  { mime: "image/jpeg", ext: ".jpg", magic: [0xFF, 0xD8, 0xFF] },
  { mime: "image/png", ext: ".png", magic: [0x89, 0x50, 0x4E, 0x47] },
  { mime: "image/gif", ext: ".gif", magic: [0x47, 0x49, 0x46, 0x38] },
  { mime: "image/webp", ext: ".webp", magic: [0x52, 0x49, 0x46, 0x46] },
] as const;

/** Derived lookups */
const MIME_TO_EXT = Object.fromEntries(IMAGE_TYPES.map((t) => [t.mime, t.ext]));
const EXT_TO_MIME = Object.fromEntries(IMAGE_TYPES.map((t) => [t.ext, t.mime]));

/**
 * Check if image storage is enabled (both env vars are set)
 */
export const isStorageEnabled = (): boolean => {
  const zoneName = getEnv("STORAGE_ZONE_NAME");
  const zoneKey = getEnv("STORAGE_ZONE_KEY");
  return !!zoneName && !!zoneKey;
};

/**
 * Get the proxy URL path for serving a decrypted image.
 * Images are encrypted on CDN, so they must be served through the proxy.
 */
export const getImageProxyUrl = (filename: string): string =>
  `/image/${filename}`;

/**
 * Get the direct CDN URL for a stored file (used internally for download).
 */
const getCdnUrl = (filename: string): string => {
  const zoneName = getEnv("STORAGE_ZONE_NAME") as string;
  return `https://${zoneName}.b-cdn.net/${filename}`;
};

/**
 * Get the MIME type for an image filename from its extension.
 */
export const getMimeTypeFromFilename = (filename: string): string | null => {
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex === -1) return null;
  return EXT_TO_MIME[filename.slice(dotIndex)] ?? null;
};

/**
 * Detect the actual image type from magic bytes.
 * Returns the MIME type if matched, null otherwise.
 */
export const detectImageType = (data: Uint8Array): string | null => {
  for (const { mime, magic } of IMAGE_TYPES) {
    if (data.length >= magic.length && magic.every((b, i) => data[i] === b)) {
      return mime;
    }
  }
  return null;
};

/** Image validation error */
export type ImageValidationError =
  | "too_large"
  | "invalid_type"
  | "invalid_content";

/** Image validation result */
export type ImageValidationResult =
  | { valid: true; detectedType: string }
  | { valid: false; error: ImageValidationError };

/**
 * Validate an image file: check MIME type, size, and magic bytes.
 */
export const validateImage = (
  data: Uint8Array,
  contentType: string,
): ImageValidationResult => {
  if (data.byteLength > MAX_IMAGE_SIZE) {
    return { valid: false, error: "too_large" };
  }

  if (!IMAGE_TYPES.some((t) => t.mime === contentType)) {
    return { valid: false, error: "invalid_type" };
  }

  const detectedType = detectImageType(data);
  if (!detectedType) {
    return { valid: false, error: "invalid_content" };
  }

  return { valid: true, detectedType };
};

/** Format a validation error as a human-readable message */
export const formatImageError = (error: ImageValidationError): string => {
  switch (error) {
    case "too_large":
      return "Image must be less than 256KB";
    case "invalid_type":
      return "Only JPEG, PNG, GIF, and WebP images are allowed";
    case "invalid_content":
      return "File does not appear to be a valid image";
  }
};

/** Generate a random filename with the correct extension */
export const generateImageFilename = (detectedType: string): string => {
  const ext = MIME_TO_EXT[detectedType];
  return `${crypto.randomUUID()}${ext}`;
};

/** Connect to the Bunny storage zone */
const connectZone = (): BunnyStorageSDK.zone.StorageZone => {
  const zoneName = getEnv("STORAGE_ZONE_NAME") as string;
  const zoneKey = getEnv("STORAGE_ZONE_KEY") as string;
  return BunnyStorageSDK.zone.connect_with_accesskey(
    BunnyStorageSDK.regions.StorageRegion.Falkenstein,
    zoneName,
    zoneKey,
  );
};

/**
 * Upload an image to Bunny storage.
 * Encrypts the image bytes before uploading.
 * Returns the filename (without path) on success.
 */
export const uploadImage = async (
  data: Uint8Array,
  detectedType: string,
): Promise<string> => {
  const filename = generateImageFilename(detectedType);
  const encrypted = await encryptBytes(data);
  const sz = connectZone();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encrypted);
      controller.close();
    },
  });
  // SDK types expect Node's ReadableStream, but Deno's global ReadableStream works at runtime
  // deno-lint-ignore no-explicit-any
  await BunnyStorageSDK.file.upload(sz, `/${filename}`, stream as any, {
    contentType: "application/octet-stream",
  });
  return filename;
};

/**
 * Download and decrypt an image from Bunny CDN.
 * Returns the decrypted image bytes, or null if not found.
 */
export const downloadImage = async (filename: string): Promise<Uint8Array | null> => {
  const url = getCdnUrl(filename);
  const response = await fetch(url);
  if (!response.ok) return null;
  const encrypted = new Uint8Array(await response.arrayBuffer());
  return decryptBytes(encrypted);
};

/**
 * Delete an image from Bunny storage.
 */
export const deleteImage = async (filename: string): Promise<void> => {
  const sz = connectZone();
  await BunnyStorageSDK.file.remove(sz, `/${filename}`);
};
