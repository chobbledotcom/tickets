/**
 * The runs a hand-written text scanner skips whole: a quoted string, and a
 * comment. Walking these one step at a time is the part every such scanner
 * shares, so the shape check and the import check read them from here.
 */

/** Whether a comment opens at `index`. Neither `//` nor `/*` can open a valid
 * pattern, so this is the first question every reader of a `/` asks. */
export const opensComment = (text: string, index: number): boolean =>
  text[index] === "/" && /[/*]/.test(text[index + 1] ?? "");

/** Just past where a quoted run closes, given the quote that opened it.
 * Escapes are skipped whole, so a quote inside the text does not close it
 * early. */
export const endOfQuoted = (
  text: string,
  start: number,
  quote: string,
): number => {
  let index = start;
  while (index < text.length && text[index] !== quote) {
    index += text[index] === "\\" ? 2 : 1;
  }
  return index + 1;
};

/** Where a comment ends. A line comment runs to the newline, a block comment
 * to its closing pair, and one that never closes runs to the end of the
 * text. */
export const endOfComment = (text: string, start: number): number => {
  if (text[start + 1] === "/") {
    const newline = text.indexOf("\n", start);
    return newline === -1 ? text.length : newline;
  }
  const close = text.indexOf("*/", start + 2);
  return close === -1 ? text.length : close + 2;
};
