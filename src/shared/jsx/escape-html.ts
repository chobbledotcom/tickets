/**
 * Escape the characters that are unsafe in HTML text and attribute values.
 *
 * Kept in its own tiny module, beside the replacement helper it is built from.
 * Both the server-side JSX runtime and browser-side client scripts (for
 * example, the duplicate-group preview) can share one escaper. This avoids
 * pulling the whole renderer into the client bundle.
 */

import { replacing } from "#shared/replacements.ts";

export const escapeHtml = replacing(
  [/&/g, "&amp;"],
  [/</g, "&lt;"],
  [/>/g, "&gt;"],
  [/"/g, "&quot;"],
);
