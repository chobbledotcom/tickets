/** Escape text so a RegExp built from it matches the text literally. */
export const escapeForRegex = (text: string): string =>
  text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
