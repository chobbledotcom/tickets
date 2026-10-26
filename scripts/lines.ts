/** The text's non-blank lines, in order: split on newlines, then drop the
 *  lines a trim empties. A Windows checkout writes `\r\n` line endings; the
 *  carriage return is part of the line ending, never content, so it is
 *  stripped before the split. Shared by the report readers that must skip the
 *  padding a torn or padded file can carry. */
export const nonBlankLines = (text: string): string[] =>
  text.replaceAll("\r\n", "\n").split("\n").filter((line) => line.trim() !== "");
