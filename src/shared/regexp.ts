/** Regular expressions built from text somebody else chose. */

/**
 * Escape a literal so it can sit inside a RegExp source and match itself. A
 * name, a word to rebrand, and a SQL identifier all arrive as plain text, and
 * a `.` in any of them must match a dot rather than anything.
 */
export const escapeRegExp = (literal: string): string =>
  literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
