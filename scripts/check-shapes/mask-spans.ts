/** Where a run of text sits in a file, as UTF-16 offsets. */
export interface Span {
  end: number;
  start: number;
}

/** One run to replace before the shape scanner reads a function body. */
export interface Masked extends Span {
  as: string;
}

/** Replace parser spans that sit fully inside one function body. */
export const maskSpans = (
  source: string,
  body: Span,
  runs: readonly Masked[],
): string => {
  let masked = "";
  let cursor = body.start;
  for (const run of runs) {
    if (run.start < cursor || run.end > body.end) continue;
    masked += source.slice(cursor, run.start) + run.as;
    cursor = run.end;
  }
  return masked + source.slice(cursor, body.end);
};
