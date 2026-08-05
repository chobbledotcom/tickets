/**
 * Percent-encode text byte by byte.
 *
 * A registry line holds an anchor's name and the mutation's own text, and both
 * can carry anything a source file can. Encoding by byte means a tab and a
 * space cannot come out the same, and any character survives being written to
 * a line and read back.
 */
export const percentEncode = (text: string): string =>
  [...new TextEncoder().encode(text)]
    .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
    .join("");
