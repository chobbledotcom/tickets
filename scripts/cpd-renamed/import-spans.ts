import { parseProgram } from "#scripts/parse-program.ts";

export interface JscpdSide {
  end: number;
  name: string;
  start: number;
}

export interface SourceSpan {
  end: number;
  start: number;
}

type ProgramStatement = ReturnType<typeof parseProgram>["body"][number];
type ImportStatement = Extract<ProgramStatement, { type: "ImportDeclaration" }>;

const isImportStatement = (
  statement: ProgramStatement,
): statement is ImportStatement => statement.type === "ImportDeclaration";

export const staticImportSpans = (file: string, source: string): SourceSpan[] =>
  parseProgram(file, source)
    .body.filter(isImportStatement)
    .map((statement) => ({
      end: statement.end,
      start: statement.start,
    }));

const sourceRange = (source: string, side: JscpdSide): SourceSpan => {
  const starts = [
    0,
    ...source
      .split("")
      .flatMap((character, index) => (character === "\n" ? [index + 1] : [])),
  ];
  const valid =
    Number.isInteger(side.start) &&
    Number.isInteger(side.end) &&
    side.start >= 1 &&
    side.end >= side.start &&
    side.end <= starts.length;
  if (!valid) {
    throw new Error(
      `jscpd reported an invalid line range for ${side.name}: ${side.start}-${side.end}`,
    );
  }
  return {
    end: starts[side.end] ?? source.length,
    start: starts[side.start - 1] as number,
  };
};

export const isImportSpan = (
  source: string,
  side: JscpdSide,
  imports: readonly SourceSpan[],
): boolean => {
  const range = sourceRange(source, side);
  const overlaps = imports.filter(
    (span) => span.start < range.end && span.end > range.start,
  );
  if (overlaps.length === 0) return false;
  let cursor = range.start;
  for (const span of overlaps) {
    if (/\S/.test(source.slice(cursor, Math.max(cursor, span.start)))) {
      return false;
    }
    cursor = Math.max(cursor, Math.min(range.end, span.end));
  }
  return !/\S/.test(source.slice(cursor, range.end));
};
