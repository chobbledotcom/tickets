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

/** True when the position holds the start of a CSS newline: LF, FF, or CR
 * (the CR LF and CR FF pairs are one newline). */
const isNewline = (css: string, i: number): boolean =>
  css[i] === "\n" || css[i] === "\f" || css[i] === "\r";

/** True when the character is a raw CSS non-printable code point: U+0001 to
 * U+0008, U+000B, U+000E to U+001F, and U+007F. NUL has its own CSS
 * preprocessing, so it is not one. */
const isNonPrintable = (c: string): boolean => {
  const code = c.charCodeAt(0);
  return (
    (code >= 0x1 && code <= 0x8) ||
    code === 0xb ||
    (code >= 0xe && code <= 0x1f) ||
    code === 0x7f
  );
};

/** The value and position after one backslash that starts no hex escape. A
 * newline after the backslash joins the two lines and holds nothing. A
 * newline is LF, FF, CR, or the CR LF pair. A backslash at the end of the
 * text holds `eof`: nothing in a string, and the replacement character in an
 * unquoted url token. */
const afterBackslash = (
  css: string,
  i: number,
  value: string,
  eof: string,
): Span => {
  const c = css[i + 1];
  if (c === undefined) return [value + eof, i + 1];
  if (c === "\n" || c === "\f") return [value, i + 2];
  if (c === "\r") return [value, css[i + 2] === "\n" ? i + 3 : i + 2];
  return [value + c, i + 2];
};

/** Append the one character at `i` to `value`. A character that starts a CSS
 * escape decodes the escape: up to six hex digits and one following
 * whitespace, or the literal next character. The whitespace is one newline,
 * and a newline is one or two characters. A value above the highest code
 * point holds the replacement character. */
const appendChar = (css: string, i: number, value: string, eof = ""): Span => {
  if (css[i] !== "\\") return [value + css[i], i + 1];
  const hex = HEX_ESCAPE.exec(css.slice(i + 1, i + 7));
  if (hex) {
    const code = Number.parseInt(hex[0], 16);
    let after = i + 1 + hex[0].length;
    if (css[after] === "\r") after += css[after + 1] === "\n" ? 2 : 1;
    else if (isWhitespace(css[after])) after += 1;
    return [
      value + (code > 0x10ffff ? "\u{FFFD}" : String.fromCodePoint(code)),
      after,
    ];
  }
  return afterBackslash(css, i, value, eof);
};

/** One run of characters with escapes decoded. The run ends at the first
 * character `stops` refuses. `eof` holds what a backslash at the end of the
 * text decodes to. Returns the value and the position of that character, or
 * the end of the text. */
const readRun = (
  css: string,
  i: number,
  stops: (c: string, at: number) => boolean,
  eof = "",
): Span => {
  let value = "";
  let j = i;
  while (j < css.length && !stops(css[j]!, j)) {
    [value, j] = appendChar(css, j, value, eof);
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
 * after the close when the close follows. The end of the text terminates the
 * token too. Nothing when the token is broken. */
const endUrlBody = (css: string, value: string, k: number): Span => {
  if (css[k] === ")") return [value, k + 1];
  if (css[k] === undefined) return [value, k];
  return ["", skipToClose(css, k)];
};

/** One string token: the decoded value between two equal quotes. The end of
 * the text terminates the string too. A raw newline makes it a bad string
 * that holds nothing, and the browser fetches nothing for it. */
const readString = (css: string, i: number, quote = css[i]!): Span => {
  const [value, j] = readRun(
    css,
    i + 1,
    (c) => c === quote || c === "\n" || c === "\r" || c === "\f",
  );
  if (css[j] === quote) return [value, j + 1];
  if (css[j] === undefined) return [value, j];
  return ["", j];
};

/** The address one url() token holds: a quoted string, or the raw unquoted
 * text to the closing parenthesis, with the surrounding whitespace gone.
 * The end of the text terminates the token. A quote or a parenthesis before
 * the close makes the token invalid, and an invalid token fetches
 * nothing. */
const readUrlBody = (css: string, i: number): Span => {
  const start = afterWhitespace(css, i);
  const c = css[start];
  if (c === '"' || c === "'") {
    const [value, after] = readString(css, start);
    // The gap between the string and the close holds whitespace and
    // comments: the tokenizer reads both between tokens.
    let k = afterWhitespace(css, after);
    while (css[k] === "/" && css[k + 1] === "*") {
      const end = css.indexOf("*/", k + 2);
      if (end === -1) {
        k = css.length;
        break;
      }
      k = afterWhitespace(css, end + 2);
    }
    return endUrlBody(css, value, k);
  }
  const [raw, stopped] = readRun(
    css,
    start,
    (c, at) =>
      stopsUrlRun(c) ||
      isNonPrintable(c) ||
      (c === "\\" && isNewline(css, at + 1)),
    // An unquoted url escape at the end of the text holds the replacement
    // character, so the address matches the one Chromium fetches.
    "\u{FFFD}",
  );
  if (css[stopped] === ")") return [raw, stopped + 1];
  if (css[stopped] === undefined) return [raw, stopped];
  if (isWhitespace(css[stopped])) {
    return endUrlBody(css, raw, afterWhitespace(css, stopped));
  }
  // A raw newline after a backslash, a raw non-printable, a quote, or an
  // open parenthesis makes a bad url token. A bad url token fetches
  // nothing.
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
  const [word, next] = readRun(
    css,
    i,
    (c, at) =>
      (c !== "\\" && !isIdentChar(c)) || (c === "\\" && isNewline(css, at + 1)),
  );
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
