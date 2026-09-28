/**
 * The body text for a `<textarea>` that shows stored user content.
 *
 * HTML parsing drops the first newline directly after a `<textarea>` start
 * tag, so a value that begins with one would lose it on first render and a
 * save would quietly change the text. The body carries one spare newline for
 * the parser to eat, and the value reaches the browser untouched.
 */

export const textareaBody = (value: string): string => `\n${value}`;
