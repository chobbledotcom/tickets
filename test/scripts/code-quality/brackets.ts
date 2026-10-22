/**
 * Bracket walks over pre-blanked TypeScript text. The text arrives with
 * strings, comments, and regular expressions already blanked, so no bracket
 * inside them can mislead a walk. Both bind detectors read these walks, so
 * they live here, in a module neither detector imports the other through.
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
