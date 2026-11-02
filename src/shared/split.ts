/** Split text on a separator and drop the empty parts. With `trim`, each part
 *  loses the spaces around it first, so a part of only spaces is dropped too.
 *  A repeated separator adds no part. */
export const splitParts =
  (separator: string | RegExp, trim = false) =>
  (text: string): string[] =>
    text
      .split(separator)
      .map((part) => (trim ? part.trim() : part))
      .filter((part) => part !== "");

/** The non-blank lines of a block of text, each trimmed. */
export const nonBlankLines: (text: string) => string[] = splitParts(
  /\r?\n/,
  true,
);

/** The trimmed, non-blank entries of a comma-separated list. */
export const commaParts: (text: string) => string[] = splitParts(",", true);
