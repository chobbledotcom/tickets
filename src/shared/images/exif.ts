/**
 * EXIF orientation for the image pipeline. A camera describes the upright
 * view of its stored scanline pixels with an EXIF orientation tag that the
 * wasm JPEG decoder ignores. The tag must be read from the file and baked
 * into the pixels before any resize or re-encode. Every stored variant is a
 * fresh WebP, and a tag that is never copied cannot survive one.
 *
 * The parser walks the JPEG segment chain, finds the APP1 "Exif" payload, and
 * reads tag 0x0112 (orientation, SHORT) from IFD0 in either byte order. A
 * missing or malformed tag yields 1 (display as stored).
 */

import type { RawImage } from "./types.ts";

/** The EXIF orientation values: 1 unrotated, then the flips and quarter turns
 * a camera writes. Anything outside 1–8 reads as 1. */
export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

const EXIF_ORIENTATION_TAG = 0x0112;

/** Read one unsigned value of `width` bytes at `offset` in `bytes`, in the
 * byte order the TIFF header declared. */
const readUint = (
  bytes: Uint8Array,
  offset: number,
  littleEndian: boolean,
  width: 2 | 4,
): number => {
  let value = 0;
  for (let index = 0; index < width; index += 1) {
    const at = littleEndian ? offset + index : offset + width - 1 - index;
    value |= bytes[at]! << (8 * index);
  }
  return value >>> 0;
};

const EXIF_HEADER = Uint8Array.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);

/** Whether a segment payload names Exif. */
const namesExif = (payload: Uint8Array): boolean =>
  EXIF_HEADER.every((byte, index) => payload[index] === byte);

/** Whether a marker carries no length and stands alone in the chain. */
const isStandaloneMarker = (marker: number): boolean =>
  marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);

/** The APP1 payload that names Exif, or undefined when the segment chain
 * carries none ahead of the scan. */
const exifApp1Payload = (data: Uint8Array): Uint8Array | undefined => {
  let offset = 2;
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) return;
    const marker = data[offset + 1]!;
    if (isStandaloneMarker(marker)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda) return; // start of scan: no EXIF ahead
    const length = readUint(data, offset + 2, false, 2);
    const payload = data.subarray(offset + 4, offset + 2 + length);
    if (marker === 0xe1 && namesExif(payload)) {
      return payload.subarray(EXIF_HEADER.length);
    }
    offset += 2 + length;
  }
  return;
};

/** The IFD0 entry's inline SHORT value for the orientation tag, or undefined
 * when the table does not carry a usable one. */
const orientationEntryValue = (
  tiff: Uint8Array,
  ifdOffset: number,
  littleEndian: boolean,
): number | undefined => {
  const entryCount = readUint(tiff, ifdOffset, littleEndian, 2);
  for (let entry = 0; entry < entryCount; entry += 1) {
    const at = ifdOffset + 2 + entry * 12;
    if (at + 12 > tiff.length) return;
    if (readUint(tiff, at, littleEndian, 2) !== EXIF_ORIENTATION_TAG) continue;
    if (readUint(tiff, at + 2, littleEndian, 2) !== 3) {
      return; // SHORT is the only type cameras write
    }
    if (readUint(tiff, at + 4, littleEndian, 4) !== 1) {
      return; // one value: only then does the inline field carry it
    }
    return readUint(tiff, at + 8, littleEndian, 2);
  }
  return;
};

/** Read the TIFF structure from an APP1 payload and return the orientation
 * tag's value, or undefined when the structure does not carry a usable one. */
const orientationFromTiff = (tiff: Uint8Array): ExifOrientation | undefined => {
  const byteOrder = String.fromCharCode(tiff[0]!, tiff[1]!);
  const littleEndian = byteOrder === "II";
  if (
    (!littleEndian && byteOrder !== "MM") ||
    readUint(tiff, 2, littleEndian, 2) !== 42
  ) {
    return;
  }
  const value = orientationEntryValue(
    tiff,
    readUint(tiff, 4, littleEndian, 4),
    littleEndian,
  );
  return value !== undefined && value >= 1 && value <= 8
    ? (value as ExifOrientation)
    : undefined;
};

/** Read the EXIF orientation a JPEG's pixels must be transformed by to
 * display upright. Returns 1 when the file carries no usable tag. */
export const readJpegOrientation = (data: Uint8Array): ExifOrientation => {
  const payload = exifApp1Payload(data);
  return (
    (payload === undefined ? undefined : orientationFromTiff(payload)) ?? 1
  );
};

/** Copy one RGBA pixel from `src` at `(sourceX, sourceY)` into `dst` at
 * `(destinationX, destinationY)`. */
const copyPixel = (
  src: RawImage,
  dst: RawImage,
  sourceX: number,
  sourceY: number,
  destinationX: number,
  destinationY: number,
): void => {
  const from = (sourceY * src.width + sourceX) * 4;
  const to = (destinationY * dst.width + destinationX) * 4;
  dst.data.set(src.data.subarray(from, from + 4), to);
};

type PixelMapper = (image: RawImage, x: number, y: number) => [number, number];

/** The pixel mapping per orientation: where the destination pixel at (x, y)
 * reads its source from. Widths and heights swap for the quarter turns. */
const MAPPINGS: Record<ExifOrientation, PixelMapper> = {
  1: (_image, x, y) => [x, y],
  2: (image, x, y) => [image.width - 1 - x, y], // mirror left-right
  3: (image, x, y) => [image.width - 1 - x, image.height - 1 - y], // 180°
  4: (image, x, y) => [x, image.height - 1 - y], // mirror top-bottom
  5: (_image, x, y) => [y, x], // transpose: mirror across the main diagonal
  6: (image, x, y) => [y, image.height - 1 - x], // rotate 90° clockwise
  7: (image, x, y) => [image.width - 1 - y, image.height - 1 - x], // transverse
  8: (image, x, y) => [image.width - 1 - y, x], // rotate 90° counter-clockwise
};

/** Whether the orientation swaps the image's width and height: the quarter
 * turns and their mirrored variants. */
const swapsAxes = (orientation: ExifOrientation): boolean => orientation >= 5;

/** Apply the pixel transform an EXIF orientation describes, returning a new
 * image. Orientation 1 returns the input unchanged. */
export const applyExifOrientation = (
  image: RawImage,
  orientation: ExifOrientation,
): RawImage => {
  if (orientation === 1) return image;
  const width = swapsAxes(orientation) ? image.height : image.width;
  const height = swapsAxes(orientation) ? image.width : image.height;
  const mapped: RawImage = {
    data: new Uint8ClampedArray(width * height * 4),
    height,
    width,
  };
  const map = MAPPINGS[orientation];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [sourceX, sourceY] = map(image, x, y);
      copyPixel(image, mapped, sourceX, sourceY, x, y);
    }
  }
  return mapped;
};
