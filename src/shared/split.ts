/** Splitting text into trimmed, non-blank parts. */

/** Split text on a separator, trim each part, and drop the blank ones. */
const splitTrimmed =
  (separator: string | RegExp) =>
  (text: string): string[] =>
    text
      .split(separator)
      .map((part) => part.trim())
      .filter((part) => part !== "");

/** The non-blank lines of a block of text, each trimmed. */
export const nonBlankLines: (text: string) => string[] = splitTrimmed(/\r?\n/);

/** The trimmed, non-blank entries of a comma-separated list. */
export const commaParts: (text: string) => string[] = splitTrimmed(",");
