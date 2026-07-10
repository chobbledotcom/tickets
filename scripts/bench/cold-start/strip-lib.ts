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

/**
 * Empty out *any* double-quoted string longer than `minChars`, including ones
 * with escape sequences (the inlined client JS/CSS assets).
 *
 * This walks the file and pairs every double quote with its matching
 * unescaped closing quote, so a "string" can never start at another string's
 * *closing* quote and swallow the code between two literals — the trap a
 * plain regex falls into when a short string is followed by a long
 * quote-free stretch of code. Known limit: a double quote inside a template
 * literal or regex literal would desync the pairing; esbuild-minified output
 * normalises strings to double quotes, and a corrupted variant fails the
 * benchmark loudly because the child process can no longer import it.
 */
export const stripLongStrings = (
  code: string,
  minChars: number,
): StripResult => {
  const stripped: StrippedPayload[] = [];
  let out = "";
  let i = 0;
  while (i < code.length) {
    if (code[i] !== '"') {
      out += code[i];
      i++;
      continue;
    }
    // Scan from the opening quote to its matching unescaped closing quote.
    let j = i + 1;
    while (j < code.length && code[j] !== '"') {
      j += code[j] === "\\" ? 2 : 1;
    }
    const literal = code.slice(i, j + 1);
    if (j < code.length && literal.length - 2 >= minChars) {
      stripped.push({ lengthChars: literal.length - 2, startIndex: i });
      out += '""';
    } else {
      out += literal;
    }
    i = j + 1;
  }
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
