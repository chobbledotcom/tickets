/**
 * Transcode an uploaded image into one or more WebP variants.
 *
 * The source is decoded once, then each requested target is produced by
 * downscaling to its max width and encoding to WebP at its quality. Callers
 * pass an array of targets and get back a parallel array of encoded byte
 * buffers — one image in, one-or-many WebP variants out.
 */

import { decodeImage, encodeWebp } from "./codecs.ts";
import { resizeToMaxWidth } from "./resize.ts";
import type { DecodableMime, ImageTarget } from "./types.ts";

/**
 * Decode `data` (of type `mime`) and produce one WebP buffer per target, in the
 * same order. Decoding happens once regardless of how many variants are asked
 * for; variants are encoded sequentially (the wasm codec is single-instance).
 */
export const transcodeToWebp = async (
  data: Uint8Array,
  mime: DecodableMime,
  targets: ReadonlyArray<ImageTarget>,
): Promise<Uint8Array[]> => {
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
