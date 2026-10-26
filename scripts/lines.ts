/** The text's non-blank lines, in order: split on newlines, then drop the
 *  lines a trim empties. Shared by the report readers that must skip the
 *  padding a torn or padded file can carry. */
export const nonBlankLines = (text: string): string[] =>
  text.split("\n").filter((line) => line.trim() !== "");
