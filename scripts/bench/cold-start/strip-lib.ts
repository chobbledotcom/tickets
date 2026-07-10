/**
 * Pure helpers for the bundle-load benchmark.
 *
 * The benchmark builds "what if" variants of the production bundle with the
 * huge inlined string payloads emptied out, so we can measure how much V8
 * parse/compile time those strings cost on a cold start. The variants are
 * only ever *loaded* (never asked to encode an image), so emptying the
 * payloads keeps the bundle loadable while removing the bytes.
 *
 * Only the base64 WASM blobs are stripped from the built output — their
 * charset makes the match unambiguous. The inlined client assets are
 * emptied at *build* time instead (`emptyInlinedAssets` in the bundle
 * pipeline), because reliably finding arbitrary string literals in minified
 * JS would need a real lexer (a regex literal containing a double quote is
 * enough to fool anything simpler).
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
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};
