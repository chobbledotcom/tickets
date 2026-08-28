/**
 * The commas of a line that sit at one bracket depth, and the index that
 * closed the nesting. The SQL column reader and the e2e label check split
 * at top-level commas this one way, so the two cannot drift apart.
 */

/** What one split found. */
export interface TopLevelCommas {
  /** Every comma that sits at the target depth, in order. */
  readonly commas: readonly number[];
  /** The first index that closed past the target depth, or the text's end
   * when nothing closed it or the scan did not stop. */
  end: number;
}

/** How one line is split at its top-level commas. */
export interface CommaSplit {
  /** Characters that close one nesting level, for example ")". */
  readonly closers: string;
  /** The depth a comma must sit at. */
  readonly depth: number;
  /** Characters that open one nesting level, for example "(". */
  readonly openers: string;
  /** The first index the scan reads. */
  readonly start: number;
  /** Stop at the first character that closes past the target depth. */
  readonly stopWhenClosed: boolean;
}

/** How one character changes the nesting level. */
const levelStep = (char: string, openers: string, closers: string): number =>
  (openers.includes(char) ? 1 : 0) - (closers.includes(char) ? 1 : 0);

/**
 * The commas of `text` that sit at `split.depth` (see CommaSplit).
 * Iterating a fixed character list leaves no index arithmetic a mutant can
 * freeze (see TODO, "Loop-freezing mutants stall whole mutation runs").
 */
export const topLevelCommas = (
  text: string,
  split: CommaSplit,
): TopLevelCommas => {
  const commas: number[] = [];
  const { closers, depth, openers, start, stopWhenClosed } = split;
  let level = depth;
  let end = text.length;
  for (const [i, char] of Array.from(text).entries()) {
    if (i < start) continue;
    level += levelStep(char, openers, closers);
    if (stopWhenClosed && level === depth - 1) {
      end = i;
      break;
    }
    if (char === "," && level === depth) commas.push(i);
  }
  return { commas, end };
};
