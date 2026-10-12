import { escapeHtml } from "#jsx/escape-html.ts";

/** Escape text for XML (extends HTML escaping with apostrophe). */
export const escapeXml = (text: string): string =>
  escapeHtml(text).replace(/'/g, "&apos;");
