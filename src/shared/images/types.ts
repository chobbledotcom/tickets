/**
 * Shared value types for the image pipeline.
 *
 * `RawImage` is the decoded, in-memory representation every stage passes
 * around: RGBA pixels plus dimensions. It is structurally compatible with the
 * DOM `ImageData` the jSquash codecs return and accept, so it flows straight
 * through decode → resize → encode without conversion.
 */

/** Decoded RGBA image: `data` is `width * height * 4` bytes, row-major. */
export interface RawImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** One WebP output variant: cap the width at `maxWidth`, encode at `quality`. */
export interface ImageTarget {
  /** Longest edge (width) the variant may have; never upscales past the source. */
  maxWidth: number;
  /** WebP quality 0–100 passed to the libwebp encoder. */
  quality: number;
}

/** MIME types the pipeline can decode (the accepted image-upload formats). */
export type DecodableMime = "image/jpeg" | "image/png" | "image/webp";
