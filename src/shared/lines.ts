/** Split text into its non-blank lines, each trimmed. A line that is empty or
 *  only whitespace is dropped, so callers get just the lines that carry text. */
export const nonBlankLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
