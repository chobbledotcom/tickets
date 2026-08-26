/**
 * Bunny CDN storage integration for uploaded images and listing attachments.
 * Uses @bunny.net/storage-sdk to upload/delete files.
 * Only enabled when STORAGE_ZONE_NAME and STORAGE_ZONE_KEY env vars are set.
 * Files are encrypted with DB_ENCRYPTION_KEY before upload.
 */

import { decryptBytes, encryptBytes } from "#crypto/encryption.ts";
import { lazyRef, once, sort } from "#fp";
import { getEnv } from "#shared/env.ts";
import {
  canDecodeImageMime,
  type DecodableMime,
  IMAGE_FORMATS,
  IMAGE_MIMES,
  type ImageMime,
} from "#shared/images/formats.ts";
import type { ImageTargetTranscoder } from "#shared/images/transcode.ts";
import {
  formatBytes,
  MAX_ATTACHMENT_SIZE,
  MAX_IMAGE_SIZE,
} from "#shared/limits.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { createScopedValue } from "#shared/request-scoped.ts";
import { streamChunks } from "#shared/stream-chunks.ts";
import { countExternalSubrequest } from "#shared/subrequest-budget.ts";
import { getDeleteOverride } from "#shared/test-overrides.ts";
import type { NonEmptyString } from "#shared/validation/string.ts";

// ---------------------------------------------------------------------------
// Per-context storage config (eliminates env var races in concurrent tests)
// ---------------------------------------------------------------------------

interface StorageConfig {
  /** Override local storage path for tests. "" = disabled, undefined = use env var. */
  localPath?: string;
  zoneKey: string;
  zoneName: string;
}

// Suite-level storage config for tests (describeWithEnv's `storage` option).
// Layered *under* the per-call runWithStorageConfig scope and *over* the process
// env, so a whole suite can declare its backend once — without wrapping each test
// body or mutating STORAGE_ZONE_*/LOCAL_STORAGE_PATH env vars. Held as a typed
// StorageConfig object, not env strings, so it can't reintroduce the env-var
// races runWithStorageConfig exists to avoid; a per-test runWithStorageConfig
// scope still wins over it.
const [getTestStorageConfig, storageConfigRef] = lazyRef<StorageConfig | null>(
  () => null,
);

/** The test-supplied config: the per-call scope first, else the suite-level
 * default, else null (⇒ read the process env). */
const configOverride = createScopedValue<StorageConfig | null>(
  getTestStorageConfig,
);

/** Run `fn` with an isolated storage configuration (test-only). */
export const runWithStorageConfig = <T>(
  config: StorageConfig,
  fn: () => T,
): T => configOverride.run(config, fn);

/**
 * Test-only: set the suite-level storage config that describeWithEnv's `storage`
 * option applies. A directly-exported named function (not an `export {}` list,
 * which the test-hook scanner does not detect, nor a module-level alias) so it is
 * visible to and registered in `ALLOWED_TEST_HOOKS`
 * (test/lib/code-quality.test.ts), alongside `runWithStorageConfig`.
 */
export function setStorageConfigForTest(config: StorageConfig | null): void {
  storageConfigRef(config);
}

/**
 * Read storage config: per-call scope first, then the suite-level test
 * default, then env vars.
 */
const getStorageConfig = (): StorageConfig => {
  const ctx = configOverride.read();
  if (ctx) return ctx;
  return {
    zoneKey: getEnv("STORAGE_ZONE_KEY") || "",
    zoneName: getEnv("STORAGE_ZONE_NAME") || "",
  };
};

/**
 * Get the effective local storage path.
 * Returns null if local storage is not configured or explicitly disabled.
 */
const getLocalStoragePath = (): string | null => {
  const ctx = configOverride.read();
  if (ctx && "localPath" in ctx) {
    return ctx.localPath || null;
  }
  return getEnv("LOCAL_STORAGE_PATH") || null;
};

/** Derived lookup: file extension → MIME type, for serving stored files. */
const EXT_TO_MIME = Object.fromEntries(
  IMAGE_MIMES.map((mime) => [IMAGE_FORMATS[mime].extension, mime]),
) as Record<string, ImageMime>;

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

/** Name of the configured Bunny storage zone, or null when Bunny is not the
 * active backend. Shown to operators so they can tell which zone a page reads. */
export const storageZoneName = (): string | null =>
  getStorageBackend() === "bunny" ? getStorageConfig().zoneName : null;

/**
 * Get the MIME type for an image filename from its extension.
 */
export const getMimeTypeFromFilename = (filename: string): ImageMime | null => {
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex === -1) return null;
  return EXT_TO_MIME[filename.slice(dotIndex)] || null;
};

/**
 * Detect the actual image type from magic bytes.
 * Returns the MIME type if matched, null otherwise.
 */
export const detectImageType = (data: Uint8Array): ImageMime | null => {
  for (const mime of IMAGE_MIMES) {
    const { magic } = IMAGE_FORMATS[mime];
    const matches = magic.every(
      ({ bytes, offset }) =>
        data.length >= offset + bytes.length &&
        bytes.every((byte, index) => data[offset + index] === byte),
    );
    if (matches) {
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
  | { valid: true; detectedType: DecodableMime }
  | { valid: false; error: ImageValidationError };

/**
 * Validate an image file: check size, the declared MIME type, and the magic
 * bytes. Both the declared type and the sniffed content must be an accepted
 * upload format; a mismatch or an unsupported format (e.g.
 * a GIF, or a file whose bytes don't match any decodable format) is rejected.
 * On success, `detectedType` is the sniffed format the transcoder will decode.
 */
export const validateImage = (
  data: Uint8Array,
  contentType: string,
): ImageValidationResult => {
  if (data.byteLength > MAX_IMAGE_SIZE) {
    return { error: "too_large", valid: false };
  }

  if (!canDecodeImageMime(contentType)) {
    return { error: "invalid_type", valid: false };
  }

  const detectedType = detectImageType(data);
  if (!detectedType || !canDecodeImageMime(detectedType)) {
    return { error: "invalid_content", valid: false };
  }

  return { detectedType, valid: true };
};

/** User-facing messages for image validation errors */
export const IMAGE_ERROR_MESSAGES: Record<ImageValidationError, string> = {
  invalid_content: "File does not appear to be a valid image",
  invalid_type: "Image must be a JPEG, PNG, or WebP file",
  too_large: `Image exceeds the ${formatBytes(MAX_IMAGE_SIZE)} size limit`,
};

/** Try to delete a file from storage, logging errors on failure */
export const tryDeleteFile = async (
  filename: string,
  listingId: number | undefined,
  detail: string,
): Promise<void> => {
  try {
    await deleteFile(filename);
  } catch {
    logError({ code: ErrorCode.STORAGE_DELETE, detail, listingId });
  }
};

/** Listing shape that owns an attachment file */
type ListingWithAttachmentStorage = {
  id: number;
  attachment_url: string;
};

/** Image shape that owns storage files */
type ImageWithStorage = {
  id: number;
  filename: NonEmptyString;
  filename_thumb: NonEmptyString;
};

/** Delete the attachment file for a single listing */
export const deleteListingAttachmentFile = async (
  listing: ListingWithAttachmentStorage,
  reason: string,
): Promise<void> => {
  if (listing.attachment_url) {
    await tryDeleteFile(listing.attachment_url, listing.id, reason);
  }
};

/** Delete all attachment files for a list of listings */
export const deleteAllListingAttachmentFiles = async (
  listings: readonly ListingWithAttachmentStorage[],
): Promise<void> => {
  for (const listing of listings) {
    await deleteListingAttachmentFile(listing, "database reset");
  }
};

/** Delete the full-size image and thumbnail files for a first-class image. */
export const deleteImageStorageFiles = async (
  image: ImageWithStorage,
  reason: string,
): Promise<void> => {
  await tryDeleteFile(image.filename, image.id, reason);
  await tryDeleteFile(image.filename_thumb, image.id, reason);
};

/** True for a "the file is already gone" deletion error from either backend, so
 * a retried delete treats an already-removed file as success. */
const isAlreadyDeleted = (err: unknown): boolean =>
  err instanceof Error &&
  (err.message.startsWith("File not found:") || err.name === "NotFound");

/**
 * Delete an image's storage files, throwing if any file could not be removed
 * (a file that is already gone counts as success, so retries are safe). Unlike
 * {@link deleteImageStorageFiles}, this surfaces failures so the caller can
 * keep the image's DB record for a later retry instead of orphaning the stored
 * files under a deleted record.
 */
export const deleteImageStorageFilesStrict = async (
  image: ImageWithStorage,
): Promise<void> => {
  const results = await Promise.allSettled([
    deleteFile(image.filename),
    deleteFile(image.filename_thumb),
  ]);
  const failure = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason)
    .find((reason) => !isAlreadyDeleted(reason));
  if (failure) throw failure;
};

/** Delete all first-class image files. */
export const deleteAllImageStorageFiles = async (
  images: readonly ImageWithStorage[],
): Promise<void> => {
  for (const image of images) {
    await deleteImageStorageFiles(image, "database reset");
  }
};

/** Generate a random `.webp` filename. Every uploaded image is transcoded to
 * WebP, so stored image variants always carry the `.webp` extension. */
export const generateWebpFilename = (): string => `${crypto.randomUUID()}.webp`;

// ---------------------------------------------------------------------------
// Local filesystem backend
// ---------------------------------------------------------------------------

/** Write encrypted bytes to the local storage directory. Filenames may include
 *  a subfolder (e.g. "acme/backup-…zip"), so create the file's parent first. */
const localWrite = async (
  data: Uint8Array,
  filename: string,
): Promise<void> => {
  const path = `${getLocalStoragePath() as string}/${filename}`;
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeFile(path, data);
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

/**
 * Lazily load the Bunny storage SDK. It is a heavy dependency (it drags in zod)
 * that only the Bunny backend's upload/download/delete calls actually use. The
 * SDK loads on the first Bunny operation, the same way the Stripe and Sentry
 * SDKs and the image codecs are dynamically imported.
 */
const loadStorageSdk = once(() => import("@bunny.net/storage-sdk"));

/** Connect to the Bunny storage zone, loading the SDK on first use. Returns both
 * the connected zone and the loaded SDK so callers can reach `sdk.file.*`. */
const connectZone = async () => {
  const config = getStorageConfig();
  if (!config.zoneName || !config.zoneKey) {
    throw new Error(
      "Storage is not configured. Set STORAGE_ZONE_NAME and STORAGE_ZONE_KEY for Bunny CDN, or LOCAL_STORAGE_PATH for local storage.",
    );
  }
  const sdk = await loadStorageSdk();
  const sz = sdk.zone.connect_with_accesskey(
    sdk.regions.StorageRegion.Falkenstein,
    config.zoneName,
    config.zoneKey,
  );
  return { sdk, sz };
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
  const { sdk, sz } = await connectZone();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  countExternalSubrequest("storage upload");
  await sdk.file.upload(sz, `/${filename}`, stream as never, {
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
 * Transcode an uploaded image to WebP, one stored file per target, returned in
 * the order of `targets`.
 *
 * The image pipeline is about 1MB of codec wasm, so it is imported here on the
 * first upload and never at cold boot.
 */
export const uploadImageTargets: ImageTargetTranscoder<string[]> = async (
  data,
  mime,
  targets,
) => {
  const { transcodeToWebp } = await import("#shared/images/transcode.ts");
  const variants = await transcodeToWebp(data, mime, targets);
  return Promise.all(
    variants.map((bytes) => encryptAndUpload(bytes, generateWebpFilename())),
  );
};

/**
 * Collect a ReadableStream into a single Uint8Array.
 */
const collectStream = async (
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  for await (const value of streamChunks(stream)) {
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
    const { sdk, sz } = await connectZone();
    countExternalSubrequest("storage download");
    const { stream } = await sdk.file.download(sz, `/${filename}`);
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
  const { sdk, sz } = await connectZone();
  countExternalSubrequest("storage delete");
  await sdk.file.remove(sz, `/${filename}`);
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

/** Strip a path's basename down with each `[pattern, replacement]` rule in
 * turn, falling back to "file" when nothing is left. Shared by every filename
 * sanitiser — each supplies its own character rules. */
export const sanitizeBasename = (
  name: string,
  ...rules: [RegExp, string][]
): string => {
  const cleaned = rules.reduce(
    (basename, [pattern, replacement]) =>
      basename.replace(pattern, replacement),
    getBasename(name),
  );
  return cleaned || "file";
};

/** Sanitize a filename for use in CDN storage (strip path, collapse whitespace) */
const sanitizeFilename = (name: string): string =>
  sanitizeBasename(name, [/[^a-zA-Z0-9._-]/g, "_"]);

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
    return await Array.fromAsync(Deno.readDir(dir));
  } catch {
    return [];
  }
};

/** A stored file with its name and size in bytes. */
export type StorageFileMeta = { name: string; size: number };

/** Sort stored files by name, ascending. */
const byName = sort<StorageFileMeta>((a, b) => a.name.localeCompare(b.name));

/**
 * Split a listing prefix into the directory to read and the leaf-name filter
 * applied within it. The directory is matched as a real path component, not a
 * string prefix, so listing one folder can never leak into a sibling whose name
 * extends it ("acme/" vs "acme-test/"):
 *   "backup-"      → read the root,   keep names starting "backup-"
 *   "acme/"        → read "acme",     keep everything
 *   "acme/backup-" → read "acme",     keep names starting "backup-"
 */
const splitListingPrefix = (
  prefix: string,
): { dir: string; namePrefix: string } => {
  const slash = prefix.lastIndexOf("/");
  return slash === -1
    ? { dir: "", namePrefix: prefix }
    : { dir: prefix.slice(0, slash + 1), namePrefix: prefix.slice(slash + 1) };
};

/**
 * List files (with size metadata) matching a path prefix, sorted by name. The
 * prefix may name a subfolder (see `splitListingPrefix`); returned names always
 * include that folder so callers can download/delete them directly. For Bunny
 * CDN the size comes from the `Length` field of the listing API.
 */
export const listFilesWithMeta = async (
  prefix: string,
): Promise<StorageFileMeta[]> => {
  const { dir, namePrefix } = splitListingPrefix(prefix);
  if (getLocalStoragePath() !== null) {
    const base = `${getLocalStoragePath() as string}/${dir}`;
    const entries = await readDirSafe(base);
    const files = await Promise.all(
      entries
        .filter((e) => e.isFile && e.name.startsWith(namePrefix))
        .map(async (e) => ({
          name: `${dir}${e.name}`,
          size: (await Deno.stat(`${base}${e.name}`)).size,
        })),
    );
    return byName(files);
  }
  const config = getStorageConfig();
  const url = `https://storage.bunnycdn.com/${config.zoneName}/${dir}`;
  countExternalSubrequest("storage directory listing");
  const response = await fetch(url, {
    headers: { AccessKey: config.zoneKey },
  });
  // A folder with no objects yet (e.g. a site that has never been backed up)
  // 404s; treat only that as "no files", the same way the local backend's
  // readDirSafe handles a missing directory. Other failures (401/403 bad
  // credentials, 5xx outages) must surface, not masquerade as an empty zone.
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(
      `Storage listing for ${prefix || "the zone root"} failed: HTTP ${response.status}`,
    );
  }
  const items = (await response.json()) as Record<string, unknown>[];
  return byName(
    items
      // Bunny lists directories alongside files; keep only files so per-site
      // backup folders don't surface as entries (the local backend filters to
      // isFile for the same reason).
      .filter((item) => !item.IsDirectory)
      .map((item) => ({
        name: String(item.ObjectName || ""),
        size: Number(item.Length) || 0,
      }))
      .filter((f) => f.name !== "" && f.name.startsWith(namePrefix))
      .map((f) => ({ name: `${dir}${f.name}`, size: f.size })),
  );
};

/** List files in storage matching a prefix (names only), sorted by name. */
export const listFiles = async (prefix: string): Promise<string[]> =>
  (await listFilesWithMeta(prefix)).map((f) => f.name);
