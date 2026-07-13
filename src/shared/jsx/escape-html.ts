/**
 * Escape the characters that are unsafe in HTML text and attribute values.
 *
 * Kept in its own tiny, dependency-free module so both the server-side JSX
 * runtime and browser-side client scripts (e.g. the duplicate-group preview)
 * can share one escaper without pulling the whole renderer into the client
 * bundle.
 */
export const escapeHtml = (str: string): string =>
  str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
