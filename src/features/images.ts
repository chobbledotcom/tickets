/**
 * Image proxy route — serves encrypted images from Bunny CDN.
 * GET /image/:filename — downloads, decrypts, and serves the image.
 * A broken image (the broken-image marker, a file missing from storage, or a
 * stored file that will not decrypt) serves a 1×1 red pixel instead of failing,
 * and the missing/unreadable cases are reported as errors.
 */

import { notFoundResponse } from "#routes/response.ts";
import type { createRouter } from "#routes/router.ts";
import { decryptBytes } from "#shared/crypto/encryption.ts";
import { getImageProxyUrl } from "#shared/image-proxy-url.ts";
import {
  BROKEN_IMAGE_FILENAME,
  BROKEN_IMAGE_PNG,
  reportBrokenImage,
} from "#shared/images/broken.ts";
import {
  downloadRaw,
  getMimeTypeFromFilename,
  isStorageEnabled,
} from "#shared/storage.ts";

type RouterFn = ReturnType<typeof createRouter>;

/** One year cache (images are immutable, filenames are random UUIDs) */
const IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** The red-pixel fallback for a broken image. Never cached, so a repaired
 * image serves for real on the very next request. */
const brokenImageResponse = (): Response =>
  new Response(BROKEN_IMAGE_PNG.buffer as BodyInit, {
    headers: { "cache-control": "no-store", "content-type": "image/png" },
  });

/** Serve a decrypted image */
const handleImageRequest = async (filename: string): Promise<Response> => {
  const mimeType = getMimeTypeFromFilename(filename);
  if (!mimeType) return notFoundResponse();

  // Only a definitively missing or unreadable file falls back to the red
  // pixel. A transient storage failure (bad credentials, an outage) still
  // throws and surfaces as the generic 503, so it keeps looking transient.
  const encrypted = await downloadRaw(filename);
  if (!encrypted) {
    reportBrokenImage(`image file ${filename} is missing from storage`);
    return brokenImageResponse();
  }

  try {
    const data = await decryptBytes(encrypted);
    return new Response(data.buffer as BodyInit, {
      headers: {
        "cache-control": IMAGE_CACHE_CONTROL,
        "content-type": mimeType,
      },
    });
  } catch (error) {
    reportBrokenImage(`image file ${filename} could not be decrypted`, error);
    return brokenImageResponse();
  }
};

/** Route image requests: GET /image/:filename */
export const routeImage: RouterFn = async (_, path, method) => {
  if (method !== "GET") return null;

  // The broken-image marker has no stored file behind it — serve its red
  // pixel directly, even when storage is not configured.
  if (path === getImageProxyUrl(BROKEN_IMAGE_FILENAME)) {
    return brokenImageResponse();
  }

  const match = path.match(/^\/image\/([a-f0-9-]+\.\w+)$/);
  if (!match?.[1]) return null;

  if (!isStorageEnabled()) return notFoundResponse();

  return await handleImageRequest(match[1]);
};
