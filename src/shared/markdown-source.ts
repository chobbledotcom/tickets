// effects: pure
/** The Markdown text that a write stores. */

/** Clean submitted Markdown text. The indentation of the first line stays,
 *  because four spaces start a code block. The blank lines before the text
 *  and the white space after it go. */
export const markdownSource = (raw: string): string =>
  raw.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd();
