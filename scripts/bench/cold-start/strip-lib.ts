/**
 * Pure helpers for the bundle-load benchmark's "what if" variants (big
 * inlined strings emptied, bundle still loadable). Only base64 WASM blobs
 * are stripped from built output — their charset is unambiguous; inlined
 * client assets are emptied at build time (`emptyInlinedAssets`) instead,
 * since finding arbitrary literals in minified JS needs a real lexer.
 */

/** One replaced string payload: where it sat and how big it was. */
export type StrippedPayload = {
  lengthChars: number;
  startIndex: number;
};

export type StripResult = {
  code: string;
  stripped: StrippedPayload[];
};

/**
 * Empty out inlined base64 payloads (the WASM codec blobs) longer than
 * `minChars`. Base64 text never contains quotes or backslashes, so a plain
 * character-class match cannot cross a string boundary.
 */
export const stripBase64Payloads = (
  code: string,
  minChars: number,
): StripResult => {
  const stripped: StrippedPayload[] = [];
  const out = code.replace(
    new RegExp(`"[A-Za-z0-9+/=]{${minChars},}"`, "g"),
    (match, offset: number) => {
      stripped.push({ lengthChars: match.length - 2, startIndex: offset });
      return '""';
    },
  );
  return { code: out, stripped };
};

/** Total characters removed by a strip pass. */
export const strippedChars = (result: StripResult): number =>
  result.stripped.reduce((sum, payload) => sum + payload.lengthChars, 0);

/** Middle value of a sorted copy — the stable summary for noisy timings. */
export const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const upper = sorted[Math.floor(sorted.length / 2)];
  if (upper === undefined) return Number.NaN;
  if (sorted.length % 2 === 1) return upper;
  return (
    sorted
      .slice(sorted.length / 2 - 1, sorted.length / 2 + 1)
      .reduce((sum, value) => sum + value, 0) / 2
  );
};

/** Median distance from the median, a robust spread summary for timings. */
export const medianAbsoluteDeviation = (values: readonly number[]): number => {
  const middle = median(values);
  return median(values.map((value) => Math.abs(value - middle)));
};
