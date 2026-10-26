import { type SourceLocation, type TlaToken, tokenizeTla } from "./lex.ts";

export type PreparedSource = {
  name: string;
  source: string;
  encoded: string;
  tokens: TlaToken[];
};
export type CloneFile = {
  name: string;
  start: number;
  end: number;
  startLoc: SourceLocation;
  endLoc: SourceLocation;
};

const encodeToken = (token: TlaToken): string => {
  let encoded = `t${token.kind}x`;
  for (let index = 0; index < token.text.length; index++) {
    encoded += token.text.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return encoded;
};

export const prepareSource = (name: string, source: string): PreparedSource => {
  const tokens = tokenizeTla(source);
  return { encoded: tokens.map(encodeToken).join("\n"), name, source, tokens };
};

const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid jscpd report object");
  }
  return value as Record<string, unknown>;
};
const integer = (value: unknown, minimum: number): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new Error("Invalid jscpd report coordinate or count");
  }
  return value;
};

export const sourceRange = (
  prepared: PreparedSource,
  value: unknown,
): CloneFile => {
  const range = object(value);
  const start = object(range.startLoc);
  const end = object(range.endLoc);
  const firstLine = integer(start.line, 1);
  const lastLine = integer(end.line, 1);
  const firstColumn = integer(start.column, 0);
  const lastColumn = integer(end.column, 0);
  const encodedLines = prepared.encoded.split("\n");
  const exclusiveNextLine = lastColumn === 0 && lastLine > firstLine;
  const finalLine = exclusiveNextLine ? lastLine - 1 : lastLine;
  const first = prepared.tokens[firstLine - 1];
  const last = prepared.tokens[finalLine - 1];
  const lastText = encodedLines[finalLine - 1];
  if (
    !first ||
    !last ||
    firstLine > finalLine ||
    firstColumn !== 0 ||
    !lastText ||
    lastColumn !== (exclusiveNextLine ? 0 : lastText.length)
  ) {
    throw new Error("jscpd clone range falls outside the prepared tokens");
  }
  return {
    end: last.end.line,
    endLoc: last.end,
    name: prepared.name,
    start: first.start.line,
    startLoc: first.start,
  };
};

export const translateReport = (
  value: unknown,
  sources: ReadonlyMap<string, PreparedSource>,
): Record<string, unknown> => {
  const report = object(value);
  const total = object(object(report.statistics).total);
  if (integer(total.sources, 1) !== sources.size) {
    throw new Error("jscpd did not analyse every selected source.");
  }
  integer(total.tokens, 1);
  if (!Array.isArray(report.duplicates))
    throw new Error("Missing jscpd duplicates");
  const translateFile = (value: unknown): CloneFile => {
    const file = object(value);
    const prepared =
      typeof file.name === "string" ? sources.get(file.name) : undefined;
    if (!prepared)
      throw new Error(`Unknown prepared source: ${String(file.name)}`);
    return sourceRange(prepared, file);
  };
  const duplicates = report.duplicates.map((value: unknown) => {
    const clone = object(value);
    const firstFile = translateFile(clone.firstFile);
    const secondFile = translateFile(clone.secondFile);
    const prepared = sources.get(String(object(clone.firstFile).name));
    if (!prepared) throw new Error("Missing clone source");
    return {
      ...clone,
      firstFile,
      format: "tla",
      fragment: prepared.source.slice(
        firstFile.startLoc.position,
        firstFile.endLoc.position,
      ),
      lines: firstFile.end - firstFile.start + 1,
      secondFile,
    };
  });
  return { ...report, duplicates };
};
