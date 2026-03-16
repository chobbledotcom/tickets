/**
 * Bunny CDN storage integration for event images and attachments.
 * Uses @bunny.net/storage-sdk to upload/delete files.
 * Only enabled when STORAGE_ZONE_NAME and STORAGE_ZONE_KEY env vars are set.
 * Files are encrypted with DB_ENCRYPTION_KEY before upload.
 */

import * as BunnyStorageSDK from "@bunny.net/storage-sdk";
import { decryptBytes, encryptBytes } from "#lib/crypto.ts";
import { getEnv, requireEnv } from "#lib/env.ts";
import { ErrorCode, logError } from "#lib/logger.ts";

/** Maximum image file size in bytes (256KB) */
const MAX_IMAGE_SIZE = 256 * 1024;

/** Supported image types — single source of truth for mime, extension, and magic bytes */
const IMAGE_TYPES = [
  { mime: "image/jpeg", ext: ".jpg", magic: [0xff, 0xd8, 0xff] },
  { mime: "image/png", ext: ".png", magic: [0x89, 0x50, 0x4e, 0x47] },
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

/** User-facing messages for image validation errors */
export const IMAGE_ERROR_MESSAGES: Record<ImageValidationError, string> = {
  too_large: "Image exceeds the 256KB size limit",
  invalid_type: "Image must be a JPEG, PNG, GIF, or WebP file",
  invalid_content: "File does not appear to be a valid image",
};

/** Try to delete an image from CDN storage, logging errors on failure */
export const tryDeleteImage = async (
  filename: string,
  eventId: number | undefined,
  detail: string,
): Promise<void> => {
  try {
    await deleteImage(filename);
  } catch {
    logError({ code: ErrorCode.STORAGE_DELETE, detail, eventId });
  }
};

/** Generate a random filename with the correct extension */
export const generateImageFilename = (detectedType: string): string => {
  const ext = MIME_TO_EXT[detectedType];
  return `${crypto.randomUUID()}${ext}`;
};

/** Connect to the Bunny storage zone */
const connectZone = (): BunnyStorageSDK.zone.StorageZone => {
  const zoneName = requireEnv("STORAGE_ZONE_NAME");
  const zoneKey = requireEnv("STORAGE_ZONE_KEY");
  return BunnyStorageSDK.zone.connect_with_accesskey(
    BunnyStorageSDK.regions.StorageRegion.Falkenstein,
    zoneName,
    zoneKey,
  );
};

/** Encrypt and upload bytes to Bunny storage, returning the filename */
const encryptAndUpload = async (
  data: Uint8Array,
  filename: string,
): Promise<string> => {
  const encrypted = await encryptBytes(data);
  const sz = connectZone();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encrypted);
      controller.close();
    },
  });
  await BunnyStorageSDK.file.upload(sz, `/${filename}`, stream, {
    contentType: "application/octet-stream",
  });
  return filename;
};

/**
 * Upload an image to Bunny storage.
 * Encrypts the image bytes before uploading.
 * Returns the filename (without path) on success.
 */
export const uploadImage = (
  data: Uint8Array,
  detectedType: string,
): Promise<string> =>
  encryptAndUpload(data, generateImageFilename(detectedType));

/**
 * Collect a ReadableStream into a single Uint8Array.
 */
const collectStream = async (
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};

/** Check if an error is a storage SDK "file not found" error */
const isFileNotFound = (err: unknown): boolean =>
  err instanceof Error && err.message.startsWith("File not found:");

/**
 * Download and decrypt an image from Bunny storage.
 * Uses the storage SDK directly (same as upload/delete) instead of a CDN
 * pull zone URL, which requires a separate pull zone linked to the storage zone.
 * Returns the decrypted image bytes, or null if the file does not exist.
 */
export const downloadImage = async (
  filename: string,
): Promise<Uint8Array | null> => {
  try {
    const sz = connectZone();
    const { stream } = await BunnyStorageSDK.file.download(sz, `/${filename}`);
    const encrypted = await collectStream(stream);
    return decryptBytes(encrypted);
  } catch (err) {
    if (isFileNotFound(err)) return null;
    throw err;
  }
};

/**
 * Delete an image from Bunny storage.
 */
export const deleteImage = async (filename: string): Promise<void> => {
  const sz = connectZone();
  await BunnyStorageSDK.file.remove(sz, `/${filename}`);
};

// ---------------------------------------------------------------------------
// Attachment storage (any file type, up to 25MB)
// ---------------------------------------------------------------------------

/** Maximum attachment file size in bytes (25MB) */
export const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

/** Attachment validation error */
export type AttachmentValidationError = "too_large";

/** Attachment validation result */
export type AttachmentValidationResult =
  | { valid: true }
  | { valid: false; error: AttachmentValidationError };

/**
 * Validate an attachment file: check size only (any file type allowed).
 */
export const validateAttachment = (
  data: Uint8Array,
): AttachmentValidationResult =>
  data.byteLength > MAX_ATTACHMENT_SIZE
    ? { valid: false, error: "too_large" }
    : { valid: true };

/** User-facing messages for attachment validation errors */
export const ATTACHMENT_ERROR_MESSAGES: Record<
  AttachmentValidationError,
  string
> = {
  too_large: "Attachment exceeds the 25MB size limit",
};

/** Sanitize a filename for use in CDN storage (strip path, collapse whitespace) */
const sanitizeFilename = (name: string): string => {
  // Take only the basename (no path separators)
  const basename = name.split(/[/\\]/).pop() ?? "file";
  // Replace non-alphanumeric (except dot, hyphen, underscore) with underscore
  return basename.replace(/[^a-zA-Z0-9._-]/g, "_") || "file";
};

/** Generate a random CDN filename preserving the original name for readability */
export const generateAttachmentFilename = (originalName: string): string =>
  `${crypto.randomUUID()}-${sanitizeFilename(originalName)}`;

/**
 * Upload an attachment to Bunny storage.
 * Encrypts the file bytes before uploading.
 * Uses the provided filename (caller generates via generateAttachmentFilename).
 * Returns the filename on success.
 */
export const uploadAttachment = (
  data: Uint8Array,
  filename: string,
): Promise<string> => encryptAndUpload(data, filename);
