/**
 * Bunny CDN storage integration for event images and attachments.
 * Uses @bunny.net/storage-sdk to upload/delete files.
 * Only enabled when STORAGE_ZONE_NAME and STORAGE_ZONE_KEY env vars are set.
 * Files are encrypted with DB_ENCRYPTION_KEY before upload.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as BunnyStorageSDK from "@bunny.net/storage-sdk";
import { decryptBytes, encryptBytes } from "#shared/crypto/encryption.ts";
import { getEnv } from "#shared/env.ts";
import {
  formatBytes,
  MAX_ATTACHMENT_SIZE,
  MAX_IMAGE_SIZE,
} from "#shared/limits.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { getDeleteOverride } from "#shared/test-overrides.ts";

// ---------------------------------------------------------------------------
// Per-context storage config (eliminates env var races in concurrent tests)
// ---------------------------------------------------------------------------

interface StorageConfig {
  /** Override local storage path for tests. "" = disabled, undefined = use env var. */
  localPath?: string;
  zoneKey: string;
  zoneName: string;
}

const storageConfigStore = new AsyncLocalStorage<StorageConfig>();

/** Run `fn` with an isolated storage configuration (test-only). */
export const runWithStorageConfig = <T>(
  config: StorageConfig,
  fn: () => T,
): T => storageConfigStore.run(config, fn);

/** Read storage config: AsyncLocalStorage context first, then env vars. */
const getStorageConfig = (): StorageConfig => {
  const ctx = storageConfigStore.getStore();
  if (ctx) return ctx;
  return {
    zoneKey: getEnv("STORAGE_ZONE_KEY") ?? "",
    zoneName: getEnv("STORAGE_ZONE_NAME") ?? "",
  };
};

/**
 * Get the effective local storage path.
 * Returns null if local storage is not configured or explicitly disabled.
 */
const getLocalStoragePath = (): string | null => {
  const ctx = storageConfigStore.getStore();
  if (ctx && "localPath" in ctx) {
    return ctx.localPath || null;
  }
  return getEnv("LOCAL_STORAGE_PATH") ?? null;
};

/** Supported image types — single source of truth for mime, extension, and magic bytes */
const IMAGE_TYPES = [
  { ext: ".jpg", magic: [0xff, 0xd8, 0xff], mime: "image/jpeg" },
  { ext: ".png", magic: [0x89, 0x50, 0x4e, 0x47], mime: "image/png" },
  { ext: ".gif", magic: [0x47, 0x49, 0x46, 0x38], mime: "image/gif" },
  { ext: ".webp", magic: [0x52, 0x49, 0x46, 0x46], mime: "image/webp" },
] as const;

/** Derived lookups */
const MIME_TO_EXT = Object.fromEntries(IMAGE_TYPES.map((t) => [t.mime, t.ext]));
const EXT_TO_MIME = Object.fromEntries(IMAGE_TYPES.map((t) => [t.ext, t.mime]));

/**
 * Returns which storage backend is active: "bunny", "local", or "none".
 */
export const getStorageBackend = (): "bunny" | "local" | "none" => {
  const config = getStorageConfig();
  if (config.zoneName && config.zoneKey) return "bunny";
  if (getLocalStoragePath()) return "local";
  return "none";
};

/**
 * Check if image storage is enabled (Bunny CDN or local filesystem).
 */
export const isStorageEnabled = (): boolean => getStorageBackend() !== "none";

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
    return { error: "too_large", valid: false };
  }

  if (!IMAGE_TYPES.some((t) => t.mime === contentType)) {
    return { error: "invalid_type", valid: false };
  }

  const detectedType = detectImageType(data);
  if (!detectedType) {
    return { error: "invalid_content", valid: false };
  }

  return { detectedType, valid: true };
};

/** User-facing messages for image validation errors */
export const IMAGE_ERROR_MESSAGES: Record<ImageValidationError, string> = {
  invalid_content: "File does not appear to be a valid image",
  invalid_type: "Image must be a JPEG, PNG, GIF, or WebP file",
  too_large: `Image exceeds the ${formatBytes(MAX_IMAGE_SIZE)} size limit`,
};

/** Try to delete a file from storage, logging errors on failure */
export const tryDeleteFile = async (
  filename: string,
  eventId: number | undefined,
  detail: string,
): Promise<void> => {
  try {
    await deleteFile(filename);
  } catch {
    logError({ code: ErrorCode.STORAGE_DELETE, detail, eventId });
  }
};

/** Event shape that owns storage files */
type EventWithStorage = {
  id: number;
  image_url: string;
  attachment_url: string;
};

/** Delete the image and attachment files for a single event */
export const deleteEventStorageFiles = async (
  event: EventWithStorage,
  reason: string,
): Promise<void> => {
  if (event.image_url) {
    await tryDeleteFile(event.image_url, event.id, reason);
  }
  if (event.attachment_url) {
    await tryDeleteFile(event.attachment_url, event.id, reason);
  }
};

/** Delete all storage files (images and attachments) for a list of events */
export const deleteAllEventStorageFiles = async (
  events: ReadonlyArray<EventWithStorage>,
): Promise<void> => {
  for (const event of events) {
    await deleteEventStorageFiles(event, "database reset");
  }
};

/** Generate a random filename with the correct extension */
export const generateImageFilename = (detectedType: string): string => {
  const ext = MIME_TO_EXT[detectedType];
  return `${crypto.randomUUID()}${ext}`;
};

// ---------------------------------------------------------------------------
// Local filesystem backend
// ---------------------------------------------------------------------------

/** Write encrypted bytes to the local storage directory */
const localWrite = async (
  data: Uint8Array,
  filename: string,
): Promise<void> => {
  const dir = getLocalStoragePath() as string;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeFile(`${dir}/${filename}`, data);
};

/** Read encrypted bytes from the local storage directory. Returns null if missing. */
const localRead = async (filename: string): Promise<Uint8Array | null> => {
  const dir = getLocalStoragePath() as string;
  try {
    return await Deno.readFile(`${dir}/${filename}`);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
};

/** Remove a file from the local storage directory */
const localRemove = async (filename: string): Promise<void> => {
  const dir = getLocalStoragePath() as string;
  await Deno.remove(`${dir}/${filename}`);
};

// ---------------------------------------------------------------------------
// Bunny CDN backend
// ---------------------------------------------------------------------------

/** Connect to the Bunny storage zone */
const connectZone = (): BunnyStorageSDK.zone.StorageZone => {
  const config = getStorageConfig();
  if (!config.zoneName || !config.zoneKey) {
    throw new Error(
      "Storage is not configured. Set STORAGE_ZONE_NAME and STORAGE_ZONE_KEY for Bunny CDN, or LOCAL_STORAGE_PATH for local storage.",
    );
  }
  return BunnyStorageSDK.zone.connect_with_accesskey(
    BunnyStorageSDK.regions.StorageRegion.Falkenstein,
    config.zoneName,
    config.zoneKey,
  );
};

/** Upload raw bytes to storage, routing to local or Bunny based on config */
export const uploadRaw = async (
  data: Uint8Array,
  filename: string,
): Promise<string> => {
  if (getLocalStoragePath() !== null) {
    await localWrite(data, filename);
    return filename;
  }
  const sz = connectZone();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  await BunnyStorageSDK.file.upload(sz, `/${filename}`, stream as never, {
    contentType: "application/octet-stream",
  });
  return filename;
};

/** Encrypt and upload bytes */
const encryptAndUpload = async (
  data: Uint8Array,
  filename: string,
): Promise<string> => uploadRaw(await encryptBytes(data), filename);

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
const isFileNotFound = (err: Error): boolean =>
  err.message.startsWith("File not found:");

/** Download raw bytes from storage. Returns null if the file does not exist. */
export const downloadRaw = async (
  filename: string,
): Promise<Uint8Array | null> => {
  if (getLocalStoragePath() !== null) {
    return localRead(filename);
  }
  try {
    const sz = connectZone();
    const { stream } = await BunnyStorageSDK.file.download(sz, `/${filename}`);
    return collectStream(stream as ReadableStream<Uint8Array>);
  } catch (err) {
    if (isFileNotFound(err as Error)) return null;
    throw err;
  }
};

/**
 * Download and decrypt a file.
 * Returns the decrypted bytes, or null if the file does not exist.
 */
export const downloadImage = async (
  filename: string,
): Promise<Uint8Array | null> => {
  const encrypted = await downloadRaw(filename);
  if (encrypted === null) return null;
  return decryptBytes(encrypted);
};

/**
 * Delete a file, routing to local or Bunny based on config.
 */
export const deleteFile = async (filename: string): Promise<void> => {
  const override = getDeleteOverride();
  if (override) throw override;
  if (getLocalStoragePath() !== null) {
    await localRemove(filename);
    return;
  }
  const sz = connectZone();
  await BunnyStorageSDK.file.remove(sz, `/${filename}`);
};

// ---------------------------------------------------------------------------
// Attachment storage (any file type, up to 25MB)
// ---------------------------------------------------------------------------

// Re-export for existing consumers (imported from #shared/limits.ts at top)
export { MAX_ATTACHMENT_SIZE };

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
    ? { error: "too_large", valid: false }
    : { valid: true };

/** User-facing messages for attachment validation errors */
export const ATTACHMENT_ERROR_MESSAGES: Record<
  AttachmentValidationError,
  string
> = {
  too_large: `Attachment exceeds the ${formatBytes(
    MAX_ATTACHMENT_SIZE,
  )} size limit`,
};

/** Extract the basename from a path (handles both forward and backslash separators) */
export const getBasename = (name: string): string =>
  name.split(/[/\\]/).pop() as string;

/** Sanitize a filename for use in CDN storage (strip path, collapse whitespace) */
const sanitizeFilename = (name: string): string => {
  const basename = getBasename(name);
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

// ---------------------------------------------------------------------------
// File listing — used by backup to discover existing backup files
// ---------------------------------------------------------------------------

/** Read directory entries, returning empty array if the directory doesn't exist */
const readDirSafe = async (dir: string): Promise<Deno.DirEntry[]> => {
  try {
    const entries: Deno.DirEntry[] = [];
    for await (const entry of Deno.readDir(dir)) entries.push(entry);
    return entries;
  } catch {
    return [];
  }
};

/** A stored file with its name and size in bytes. */
export type StorageFileMeta = { name: string; size: number };

/** Compare two stored files by name, ascending. Names in a listing are unique. */
const byName = (a: StorageFileMeta, b: StorageFileMeta): number =>
  a.name < b.name ? -1 : 1;

/**
 * List files (with size metadata) matching a prefix, sorted by name.
 * For Bunny CDN the size comes from the `Length` field of the listing API.
 */
export const listFilesWithMeta = async (
  prefix: string,
): Promise<StorageFileMeta[]> => {
  if (getLocalStoragePath() !== null) {
    const dir = getLocalStoragePath() as string;
    const entries = await readDirSafe(dir);
    const files: StorageFileMeta[] = [];
    for (const entry of entries) {
      if (!entry.isFile || !entry.name.startsWith(prefix)) continue;
      const { size } = await Deno.stat(`${dir}/${entry.name}`);
      files.push({ name: entry.name, size });
    }
    return files.sort(byName);
  }
  const config = getStorageConfig();
  const url = `https://storage.bunnycdn.com/${config.zoneName}/`;
  const response = await fetch(url, {
    headers: { AccessKey: config.zoneKey },
  });
  const items = (await response.json()) as Array<Record<string, unknown>>;
  const files: StorageFileMeta[] = [];
  for (const item of items) {
    const name = String(item.ObjectName ?? "");
    if (name.startsWith(prefix)) {
      files.push({ name, size: Number(item.Length) || 0 });
    }
  }
  return files.sort(byName);
};

/** List files in storage matching a prefix (names only), sorted by name. */
export const listFiles = async (prefix: string): Promise<string[]> =>
  (await listFilesWithMeta(prefix)).map((f) => f.name);
