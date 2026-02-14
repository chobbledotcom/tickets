/**
 * Image proxy route — serves encrypted images from Bunny CDN.
 * GET /image/:filename — downloads, decrypts, and serves the image.
 */

import { downloadImage, getMimeTypeFromFilename, isStorageEnabled } from "#lib/storage.ts";
import type { createRouter } from "#routes/router.ts";
import { notFoundResponse } from "#routes/utils.ts";

type RouterFn = ReturnType<typeof createRouter>;

/** One year cache (images are immutable, filenames are random UUIDs) */
const IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Serve a decrypted image */
const handleImageRequest = async (filename: string): Promise<Response> => {
  const mimeType = getMimeTypeFromFilename(filename);
  if (!mimeType) return notFoundResponse();

  const data = await downloadImage(filename);
  if (!data) return notFoundResponse();

  return new Response(data.buffer as BodyInit, {
    headers: {
      "content-type": mimeType,
      "cache-control": IMAGE_CACHE_CONTROL,
    },
  });
};

/** Route image requests: GET /image/:filename */
export const routeImage: RouterFn = async (_, path, method) => {
  if (method !== "GET") return null;

  const match = path.match(/^\/image\/([a-f0-9-]+\.\w+)$/);
  if (!match?.[1]) return null;

  if (!isStorageEnabled()) return notFoundResponse();

  return await handleImageRequest(match[1]);
};
