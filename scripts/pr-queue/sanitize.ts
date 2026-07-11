/**
 * Strip C0/C1 control characters (including ESC) from GitHub-sourced text before
 * it reaches stdout, so a crafted title, branch, author, or fact can't inject
 * ANSI escapes into the terminal — in either the coloured report or `--json`
 * output piped to a terminal (`JSON.stringify` leaves C1 bytes unescaped). Pure,
 * so it is unit-tested directly and applied once, before either output mode.
 */

import type { PrSummary } from "./types.ts";

const isControlChar = (code: number): boolean =>
  code <= 0x1f || (code >= 0x7f && code <= 0x9f);

/** Remove C0/C1 control characters from a string, keeping all printable text. */
export const stripControlChars = (value: string): string =>
  [...value].filter((ch) => !isControlChar(ch.charCodeAt(0))).join("");

/** A copy of a summary with every GitHub-sourced string stripped of control bytes. */
export const sanitizeSummary = (summary: PrSummary): PrSummary => ({
  ...summary,
  author: stripControlChars(summary.author),
  branch: stripControlChars(summary.branch),
  facts: summary.facts.map(stripControlChars),
  title: stripControlChars(summary.title),
});
