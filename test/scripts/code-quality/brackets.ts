/**
 * Bracket walks over pre-blanked TypeScript text. The text arrives with
 * strings, comments, and regular expressions already blanked, so no bracket
 * inside them can mislead a walk. The bind detectors and the SQL helper
 * parity test read these walks, so they live here, in a module neither
 * detector imports the other through.
 */

/** The bracket that closes the `[` at `open`, or -1. */
export const matchingBracket = (blanked: string, open: number): number => {
  let depth = 0;
  for (let at = open; at < blanked.length; at++) {
    const character = blanked[at] as string;
    if ("([{".includes(character)) depth += 1;
    if (")]}".includes(character)) {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return -1;
};

/** The first index at or after `at` whose character is not whitespace. */
export const pastSpaces = (blanked: string, at: number): number => {
  let cursor = at;
  while (cursor < blanked.length && /\s/.test(blanked[cursor] as string)) {
    cursor += 1;
  }
  return cursor;
};

/** The index just past one balanced `<…>` type-argument group starting at
 * `at`, or `at` itself when no group starts there. */
export const pastTypeArguments = (blanked: string, at: number): number => {
  if (blanked[at] !== "<") return at;
  let depth = 0;
  for (let cursor = at; cursor < blanked.length; cursor++) {
    if (blanked[cursor] === "<") depth += 1;
    if (blanked[cursor] === ">") {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
  }
  return at;
};

/** Where a call's first top-level argument ends: the comma that follows it,
 * or -1 when the call passes one argument or never closes. */
export const firstArgumentComma = (blanked: string, open: number): number => {
  let depth = 0;
  for (let at = open + 1; at < blanked.length; at++) {
    const character = blanked[at] as string;
    if ("([{".includes(character)) depth += 1;
    if (")]}".includes(character)) {
      if (depth === 0) return -1;
      depth -= 1;
    }
    if (character === "," && depth === 0) return at;
  }
  return -1;
};
