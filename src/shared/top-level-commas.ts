/**
 * The commas of a line that sit at the base bracket level, and the index
 * that closed the nesting. The SQL column reader and the e2e label check
 * split at top-level commas this one way, so the two cannot drift apart.
 */

/** What one split found. */
export interface TopLevelCommas {
  /** Every comma that sits at the base level, in order. */
  readonly commas: readonly number[];
  /** The first index that closed past the base level, or the text's end
   * when nothing closed it or the scan did not stop. */
  end: number;
}

/** How one line is split at its top-level commas. */
export interface CommaSplit {
  /** Characters that close one nesting level, for example ")". */
  readonly closers: string;
  /** Characters that open one nesting level, for example "(". */
  readonly openers: string;
  /** The first index the scan reads. */
  readonly start: number;
  /** Stop at the first character that closes past the base level. */
  readonly stopWhenClosed: boolean;
}

/** How one character changes the nesting level. */
const levelStep = (char: string, openers: string, closers: string): number =>
  (openers.includes(char) ? 1 : 0) - (closers.includes(char) ? 1 : 0);

/**
 * The commas of `text` that sit at the base nesting level (see CommaSplit).
 * A fixed character list leaves no index arithmetic a mutant can
 * freeze (see TODO, "Loop-freezing mutants stall whole mutation runs").
 * `split("")` walks UTF-16 code units, so the indexes it reports work with
 * the string APIs every caller uses.
 */
export const topLevelCommas = (
  text: string,
  split: CommaSplit,
): TopLevelCommas => {
  const commas: number[] = [];
  const { closers, openers, start, stopWhenClosed } = split;
  let level = 0;
  let end = text.length;
  for (const [i, char] of text.split("").entries()) {
    if (i < start) continue;
    level += levelStep(char, openers, closers);
    if (stopWhenClosed && level === -1) {
      end = i;
      break;
    }
    if (char === "," && level === 0) commas.push(i);
  }
  return { commas, end };
};
