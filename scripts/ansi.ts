/** The escape character that starts every ANSI escape sequence. */
const ESC = String.fromCodePoint(27);

/** Remove the ANSI escape sequences terminal output carries, so line
 *  comparisons and displays read plain text. Deno colour-codes its own error
 *  lines even when its output is piped. */
export const stripAnsi = (text: string): string =>
  text.replace(new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g"), "");
