/**
 * A visual fingerprint of one screenshot. The hash answers "is this exactly the
 * reference the video used?" and the greyscale thumbnail answers "how far has
 * it moved?" when it is not exact. The thumbnail ignores colour, so a theme
 * change alone does not look like a layout change.
 */

import sharp from "sharp";
import { fromBase64, toBase64 } from "#crypto/utils.ts";
import { sha256Hex } from "#shared/sha256.ts";

export const FINGERPRINT_SIZE = 32;
const FINGERPRINT_BYTES = FINGERPRINT_SIZE * FINGERPRINT_SIZE;

export interface GuideFingerprint {
  /** Base64 of the 32×32 greyscale thumbnail, row by row. */
  grayscale: string;
  /** The exact PNG digest at the time the guide used it. */
  sha256: string;
}

export const fingerprintPng = async (
  bytes: Uint8Array,
): Promise<GuideFingerprint> => {
  const raw = await sharp(bytes)
    .resize(FINGERPRINT_SIZE, FINGERPRINT_SIZE, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();
  if (raw.length !== FINGERPRINT_BYTES) {
    throw new Error(
      `A guide fingerprint must hold ${FINGERPRINT_BYTES} bytes, not ${raw.length}`,
    );
  }
  return {
    grayscale: toBase64(new Uint8Array(raw)),
    sha256: await sha256Hex(bytes),
  };
};

const thumbnail = (fingerprint: GuideFingerprint): Uint8Array => {
  const bytes = fromBase64(fingerprint.grayscale);
  if (bytes.length !== FINGERPRINT_BYTES) {
    throw new Error(
      `A guide fingerprint must hold ${FINGERPRINT_BYTES} bytes, not ${bytes.length}`,
    );
  }
  return bytes;
};

const overPairs = (
  left: Uint8Array,
  right: Uint8Array,
  run: (leftValue: number, rightValue: number) => void,
): void => {
  for (let index = 0; index < left.length; index += 1) {
    run(left[index]!, right[index]!);
  }
};

/** One when the two screenshots are the same file. Otherwise the score keeps
 * the shape of the page (most of the weight) and the amount of light and dark
 * (the rest). A page that moved reads low even when both pages are mostly
 * white; a date that changed reads high because the layout did not move. */
export const compareFingerprints = (
  left: GuideFingerprint,
  right: GuideFingerprint,
): number => {
  if (left.sha256 === right.sha256) return 1;
  const a = thumbnail(left);
  const b = thumbnail(right);

  let sumA = 0;
  let sumB = 0;
  let difference = 0;
  overPairs(a, b, (left, right) => {
    sumA += left;
    sumB += right;
    difference += Math.abs(left - right);
  });
  const tone = 1 - difference / (255 * a.length);
  const meanA = sumA / a.length;
  const meanB = sumB / b.length;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  overPairs(a, b, (left, right) => {
    const x = left - meanA;
    const y = right - meanB;
    covariance += x * y;
    varianceA += x * x;
    varianceB += y * y;
  });
  if (varianceA === 0 || varianceB === 0) {
    return varianceA === 0 && varianceB === 0 ? tone : tone / 2;
  }
  const correlation = covariance / Math.sqrt(varianceA * varianceB);
  const structure = (correlation + 1) / 2;
  return Math.max(0, Math.min(1, structure * 0.75 + tone * 0.25));
};

/** The percentage a person reads, rounded to a whole number. */
export const freshnessPercent = (similarity: number): number =>
  Math.round(similarity * 100);
