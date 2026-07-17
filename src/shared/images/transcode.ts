/**
 * Transcode an uploaded image into one or more WebP variants.
 *
 * The source is decoded once, then each requested target is produced by
 * downscaling to its max width and encoding to WebP at its quality. Callers
 * pass an array of targets and get back a parallel array of encoded byte
 * buffers — one image in, one-or-many WebP variants out.
 */

import { decodeImage, encodeWebp } from "./codecs.ts";
import type { DecodableMime } from "./formats.ts";
import { resizeToMaxWidth } from "./resize.ts";
import type { ImageTarget } from "./types.ts";

/**
 * Turns one uploaded image (its bytes plus mime) and a list of size/quality
 * targets into some result — the shared signature of both the raw transcoder
 * (WebP bytes out) and the storage wrapper (stored filenames out).
 */
export type ImageTargetTranscoder<Result> = (
  data: Uint8Array,
  mime: DecodableMime,
  targets: readonly ImageTarget[],
) => Promise<Result>;

/**
 * Decode `data` (of type `mime`) and produce one WebP buffer per target, in the
 * same order. Decoding happens once regardless of how many variants are asked
 * for; variants are encoded sequentially (the wasm codec is single-instance).
 */
export const transcodeToWebp: ImageTargetTranscoder<Uint8Array[]> = async (
  data,
  mime,
  targets,
) => {
  const decoded = await decodeImage(data, mime);
  const variants: Uint8Array[] = [];
  for (const target of targets) {
    variants.push(
      await encodeWebp(
        resizeToMaxWidth(decoded, target.maxWidth),
        target.quality,
      ),
    );
  }
  return variants;
};
