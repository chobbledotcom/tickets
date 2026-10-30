import { escapeHtml } from "#jsx/escape-html.ts";

/** Extend HTML escaping with a replacement for apostrophes. XML and the
 * email HTML bodies escape the same set. They differ only in that one token. */
export const escapeHtmlApostrophes =
  (apostrophe: string) =>
  (text: string): string =>
    escapeHtml(text).replace(/'/g, apostrophe);

/** Escape text for XML (extends HTML escaping with apostrophe). */
export const escapeXml = escapeHtmlApostrophes("&apos;");
