/**
 * Pure helpers for the bundle-load benchmark.
 *
 * The benchmark builds "what if" variants of the production bundle with the
 * huge inlined string payloads emptied out, so we can measure how much V8
 * parse/compile time those strings cost on a cold start. The variants are
 * only ever *loaded* (never asked to encode an image or serve an asset), so
 * emptying the payloads keeps the bundle loadable while removing the bytes.
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

/** Replace every match with an empty string literal, recording what went. */
const stripMatching = (code: string, matcher: RegExp): StripResult => {
  const stripped: StrippedPayload[] = [];
  const out = code.replace(matcher, (match, offset: number) => {
    stripped.push({ lengthChars: match.length - 2, startIndex: offset });
    return '""';
  });
  return { code: out, stripped };
};

/**
 * Empty out inlined base64 payloads (the WASM codec blobs) longer than
 * `minChars`. Base64 text never contains quotes or backslashes, so a plain
 * character-class match cannot cross a string boundary.
 */
export const stripBase64Payloads = (
  code: string,
  minChars: number,
): StripResult =>
  stripMatching(code, new RegExp(`"[A-Za-z0-9+/=]{${minChars},}"`, "g"));

/**
 * Empty out *any* double-quoted string longer than `minChars`, including ones
 * with escape sequences (the inlined client JS/CSS assets). A match can only
 * start and end at unescaped quotes, so it cannot swallow code between two
 * separate strings.
 */
export const stripLongStrings = (code: string, minChars: number): StripResult =>
  stripMatching(
    code,
    new RegExp(`"(?:[^"\\\\]|\\\\[\\s\\S]){${minChars},}"`, "g"),
  );

/** Total characters removed by a strip pass. */
export const strippedChars = (result: StripResult): number =>
  result.stripped.reduce((sum, payload) => sum + payload.lengthChars, 0);

/** Middle value of a sorted copy — the stable summary for noisy timings. */
export const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};
