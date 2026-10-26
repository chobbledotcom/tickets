/**
 * The line format every registry file in this repository shares: one entry per
 * line, blank lines ignored, and a line starting with `#` a comment.
 */

/**
 * Every line that carries an entry. A blank line and a whole-line comment both
 * drop out, so a reader can head a registry with prose and a parser never has
 * to know about either.
 *
 * A Windows checkout writes `\r\n` line endings. The carriage return is part
 * of the line ending, never entry content: escapeForLine writes a real one as
 * `%0d`.
 */
export const entryLines = (text: string): string[] =>
  text
    .replaceAll("\r\n", "\n")
    .split("\n")
    .filter((line) => {
      const start = line.trimStart();
      return start !== "" && !start.startsWith("#");
    });
