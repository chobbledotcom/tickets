/**
 * The top-level `${...}` code ranges of one template literal. The code-only
 * pass and the SQL tag detector both read a template's interpolations with the
 * same escape rule, so the walk lives here once.
 */

import { interpolationEnd } from "#scripts/typescript-lex.ts";

/** One interpolation's code range: `start` is the code's first character and
 * `end` the position of the closing brace. */
export type TemplateHole = { end: number; start: number };

/** The interpolations of the template that begins at `start` and ends at `end`
 * (the position just past its closing backtick). Template text escapes the
 * next character, so `\${` stays text and `\\` is one backslash. */
export const templateHoles = (
  content: string,
  start: number,
  end: number,
): TemplateHole[] => {
  const holes: TemplateHole[] = [];
  let at = start + 1;
  while (at < end - 1) {
    if (content[at] === "\\") {
      at += 2;
      continue;
    }
    if (content[at] === "$" && content[at + 1] === "{") {
      const close = interpolationEnd(content, at + 2);
      holes.push({ end: close, start: at + 2 });
      at = close + 1;
      continue;
    }
    at += 1;
  }
  return holes;
};
