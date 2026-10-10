/**
 * The one outside origin the custom CSS can pull fonts from. When the
 * stylesheet loads fonts.bunny.net, the page CSP must name that origin. The
 * browser blocks the fonts when the policy does not name it.
 */

/** The CSP source that covers both the stylesheet and its font files. */
export const BUNNY_FONTS_ORIGIN = "https://fonts.bunny.net";

const BUNNY_FONTS_HOST = "fonts.bunny.net";

/** A url() token: quoted, or bare up to the closing parenthesis. */
const URL_TOKEN = /url\(\s*('[^']*'|"[^"]*"|[^)]*?)\s*\)/gi;

/** The stylesheet address of an @import written as a plain string. */
const IMPORT_STRING = /@import\s*('[^']*'|"[^"]*")/gi;

/** A CSS comment, closed or run to the end of the text. */
const COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/g;

/** The address one matched token holds: the wrapper text and one pair of
 * quotes peeled off. */
const addressOf = (match: string): string =>
  match
    .replace(/^url\(/i, "")
    .replace(/\)$/, "")
    .replace(/^@import\s*/i, "")
    .replace(/^'(.*)'$/, "$1")
    .replace(/^"(.*)"$/, "$1")
    .trim();

/** True when one CSS address token is an https URL on the fonts host. A
 * non-default port or a lookalike host names a resource the policy does not
 * cover, so it must not count. */
const isBunnyFontsAddress = (token: string): boolean => {
  // Only an explicit https address counts: a relative or protocol-relative
  // token names a resource on the page's own origin, not the fonts origin.
  if (!/^https:\/\//i.test(token)) return false;
  if (!URL.canParse(token)) return false;
  return new URL(token).host === BUNNY_FONTS_HOST;
};

/** True when one group of address tokens names the fonts origin. */
const anyAddressMatches = (css: string, tokens: RegExp): boolean => {
  for (const match of css.matchAll(tokens)) {
    if (isBunnyFontsAddress(addressOf(match[0]))) return true;
  }
  return false;
};

/** True when the custom CSS loads its stylesheet or a font file from
 * fonts.bunny.net over https. A comment hides its text from the browser, so
 * an address inside one never counts. */
export const cssUsesBunnyFonts = (css: string): boolean => {
  const visible = css.replace(COMMENT, "");
  return (
    anyAddressMatches(visible, URL_TOKEN) ||
    anyAddressMatches(visible, IMPORT_STRING)
  );
};
