/**
 * The one outside origin the custom CSS can pull fonts from. When the
 * stylesheet loads fonts.bunny.net, the page CSP must name that origin. The
 * browser blocks the fonts when the policy does not name it.
 */

/** The CSP source that covers both the stylesheet and its font files. */
export const BUNNY_FONTS_ORIGIN = "https://fonts.bunny.net";

const BUNNY_FONTS_HOST = "fonts.bunny.net";

const HEX_ESCAPE = /^[0-9a-f]{1,6}/i;

/** One read: the value and the position after it. */
type Span = [string, number];

/** True when the character can appear inside an identifier. */
const isIdentChar = (c: string | undefined): boolean =>
  c !== undefined && (/[a-z0-9_-]/i.test(c) || c.charCodeAt(0) > 127);

/** True when the character is CSS whitespace. */
const isWhitespace = (c: string | undefined): boolean =>
  c !== undefined && /[ \t\n\r\f]/.test(c);

/** Append the one character at `i` to `value`. A character that starts a CSS
 * escape decodes the escape: up to six hex digits and one following space,
 * or the literal next character. A newline after the backslash joins the two
 * lines and holds nothing. A value above the highest code point holds the
 * replacement character. */
const appendChar = (css: string, i: number, value: string): Span => {
  const rest = css.slice(i + 1, i + 7);
  if (css[i] !== "\\") return [value + css[i], i + 1];
  const hex = HEX_ESCAPE.exec(rest);
  if (hex) {
    const code = Number.parseInt(hex[0], 16);
    const after = i + 1 + hex[0].length;
    return [
      value + (code > 0x10ffff ? "\u{FFFD}" : String.fromCodePoint(code)),
      isWhitespace(css[after]) ? after + 1 : after,
    ];
  }
  const c = rest[0];
  if (c === undefined) return [value, i + 1];
  if (c === "\n") return [value, i + 2];
  if (c === "\r") {
    return [value, css[i + 2] === "\n" ? i + 3 : i + 2];
  }
  return [value + c, i + 2];
};

/** One run of characters with escapes decoded. The run ends at the first
 * character `stops` refuses. Returns the value and the position of that
 * character, or the end of the text. */
const readRun = (
  css: string,
  i: number,
  stops: (c: string | undefined) => boolean,
): Span => {
  let value = "";
  let j = i;
  while (j < css.length && !stops(css[j])) {
    [value, j] = appendChar(css, j, value);
  }
  return [value, j];
};

/** The position after one run of whitespace. */
const afterWhitespace = (css: string, i: number): number => {
  let k = i;
  while (isWhitespace(css[k])) k++;
  return k;
};

/** The position after the parenthesis that closes a broken url token, or the
 * end of the text. A broken token fetches nothing, so its text does not
 * matter. */
const skipToClose = (css: string, i: number): number => {
  const end = css.indexOf(")", i);
  return end === -1 ? css.length : end + 1;
};

/** The characters that end one unquoted url token: the close parenthesis, a
 * quote, an open parenthesis, and whitespace. */
const stopsUrlRun = (c: string | undefined): boolean =>
  c === ")" || c === '"' || c === "'" || c === "(" || isWhitespace(c);

/** One url() body that stopped at whitespace: the value and the position
 * after the close when the close follows. Nothing when the token is
 * broken. */
const endUrlBody = (css: string, value: string, k: number): Span =>
  css[k] === ")" ? [value, k + 1] : ["", skipToClose(css, k)];

/** One string token: the decoded value between two equal quotes. An
 * unterminated string or a raw newline ends the token and holds nothing. The
 * browser fetches nothing for it. */
const readString = (css: string, i: number, quote = css[i]!): Span => {
  const [value, j] = readRun(
    css,
    i + 1,
    (c) => c === quote || c === "\n" || c === "\r",
  );
  if (css[j] === quote) return [value, j + 1];
  return ["", j];
};

/** The address one url() token holds: a quoted string, or the raw unquoted
 * text to the closing parenthesis, with the surrounding whitespace gone. A
 * quote or a parenthesis before the close makes the token invalid, and an
 * invalid token fetches nothing. */
const readUrlBody = (css: string, i: number): Span => {
  const start = afterWhitespace(css, i);
  const c = css[start];
  if (c === '"' || c === "'") {
    const [value, after] = readString(css, start);
    return endUrlBody(css, value, afterWhitespace(css, after));
  }
  const [raw, stopped] = readRun(css, start, stopsUrlRun);
  if (css[stopped] === ")") return [raw, stopped + 1];
  if (css[stopped] === undefined) return ["", stopped];
  if (isWhitespace(css[stopped])) {
    return endUrlBody(css, raw, afterWhitespace(css, stopped));
  }
  return ["", skipToClose(css, stopped)];
};

/** True when one address token names the fonts origin. A scheme-relative
 * address resolves against the page. The site serves HTTPS, so it resolves
 * to the https origin. A non-default port or a lookalike host names a
 * resource the policy does not cover, so it must not count. */
const isBunnyFontsAddress = (address: string): boolean => {
  const resolved = address.startsWith("//") ? `https:${address}` : address;
  // Only an explicit https origin counts: the policy source is
  // scheme-specific. A relative address names a resource on the page's own
  // origin, not the fonts origin.
  if (!/^https:\/\//i.test(resolved)) return false;
  if (!URL.canParse(resolved)) return false;
  return new URL(resolved).host === BUNNY_FONTS_HOST;
};

/** The scanner state. The position, whether the walk sits in an @import
 * prelude, whether that prelude's address is read, and whether an address
 * named the fonts origin. */
type Scan = {
  inImport: boolean;
  matched: boolean;
  position: number;
  targetRead: boolean;
};

/** Read the @import prelude's address slot, and say whether it was waiting
 * for the address. The slot is read once per prelude. */
const takeImportTarget = (scan: Scan): boolean => {
  const waiting = scan.inImport && !scan.targetRead;
  scan.targetRead = true;
  return waiting;
};

/** The position after one identifier or at-keyword. The decoded word moves
 * the scanner: @import opens a prelude whose first address token is the
 * stylesheet address, and url() reads an address token. Every other word is
 * plain text. The `at` flag says whether the word follows an @ sign. */
const scanWord = (css: string, i: number, scan: Scan, at: boolean): number => {
  const [word, next] = readRun(css, i, (c) => !isIdentChar(c) && c !== "\\");
  const keyword = word.toLowerCase();
  if (at && keyword === "import") {
    scan.inImport = true;
    scan.targetRead = false;
    return next;
  }
  if (!at && keyword === "url" && css[next] === "(") {
    const [value, end] = readUrlBody(css, next + 1);
    takeImportTarget(scan);
    scan.matched = isBunnyFontsAddress(value);
    return end;
  }
  return next;
};

/** The position after one string token. A string is an address only while
 * the scanner waits for the @import stylesheet address. A string elsewhere
 * is data the browser never fetches. */
const scanString = (css: string, i: number, scan: Scan): number => {
  const [value, next] = readString(css, i);
  if (takeImportTarget(scan) && isBunnyFontsAddress(value)) {
    scan.matched = true;
  }
  return next;
};

/** Move the scanner past one token. A comment outside a string hides its
 * text from the browser, so the scanner skips it. */
const scanToken = (css: string, scan: Scan): void => {
  const i = scan.position;
  const c = css[i];
  if (c === "/" && css[i + 1] === "*") {
    const end = css.indexOf("*/", i + 2);
    scan.position = end === -1 ? css.length : end + 2;
    return;
  }
  if (c === '"' || c === "'") {
    scan.position = scanString(css, i, scan);
    return;
  }
  if (c === "@") {
    scan.position = scanWord(css, i + 1, scan, true);
    return;
  }
  if (c === ";" || c === "{" || c === "}") {
    scan.inImport = false;
    scan.position = i + 1;
    return;
  }
  if (isIdentChar(c) || c === "\\") {
    scan.position = scanWord(css, i, scan, false);
    return;
  }
  scan.position = i + 1;
};

/** True when the custom CSS loads its stylesheet or a font file from
 * fonts.bunny.net.
 *
 * The scanner walks the stylesheet the way the CSS tokenizer walks it.
 * Strings keep their raw text, so comment text inside a string stays data.
 * Identifiers, strings, and url tokens decode their escapes, so an escaped
 * address or an escaped url() name still matches. The @import stylesheet
 * address and every url() token count. A string elsewhere never counts.
 *
 * The position clamp keeps the walk advancing by one character when a token
 * reader returns no progress, so the scan always ends. */
export const cssUsesBunnyFonts = (css: string): boolean => {
  const scan: Scan = {
    inImport: false,
    matched: false,
    position: 0,
    targetRead: false,
  };
  while (scan.position < css.length && !scan.matched) {
    const before = scan.position;
    scanToken(css, scan);
    scan.position = Math.max(scan.position, before + 1);
  }
  return scan.matched;
};
