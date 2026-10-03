/** The TAP diagnostic block one failing test emits: pretty JSON or YAML,
 *  parsed into the message and location the compact summary shows. */

export type TapDiagnostic = {
  message?: string;
  severity?: string;
  at?: {
    file?: string;
    line?: number;
    column?: number;
  };
};

const STEP_FAILURE_RE = /^\d+\s+test\s+steps?\s+failed\.$/;

const leadingWhitespaceLength = (line: string): number =>
  line.match(/^\s*/)?.[0].length ?? 0;

const stripCommonIndent = (lines: string[]): string => {
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map(leadingWhitespaceLength);
  const indent = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(indent)).join("\n");
};

const parseYamlScalar = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
};

const readYamlBlockScalar = (
  lines: string[],
  startIndex: number,
  baseIndent: number,
): string => {
  const block: string[] = [];
  for (const line of lines.slice(startIndex + 1)) {
    const indent = leadingWhitespaceLength(line);
    if (line.trim() && indent <= baseIndent && /^\w[\w-]*:/.test(line.trim())) {
      break;
    }
    block.push(line);
  }
  return stripCommonIndent(block).trimEnd();
};

const parseYamlMessage = (lines: string[]): string | undefined => {
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index]?.match(/^(\s*)message:\s*(.*)$/);
    if (!match) continue;
    const value = match[2]?.trim() ?? "";
    const baseIndent = (match[1] ?? "").length;
    return value.startsWith("|") || value.startsWith(">")
      ? readYamlBlockScalar(lines, index, baseIndent)
      : parseYamlScalar(value);
  }
  return;
};

type AtFieldAssign = (
  at: NonNullable<TapDiagnostic["at"]>,
  value: string,
) => void;

const AT_FIELD_ASSIGNERS: Record<string, AtFieldAssign | undefined> = {
  column: (at, value) => {
    at.column = Number(value);
  },
  file: (at, value) => {
    at.file = value;
  },
  line: (at, value) => {
    at.line = Number(value);
  },
};

const assignAtField = (
  at: NonNullable<TapDiagnostic["at"]>,
  key: string,
  value: string,
): void => {
  AT_FIELD_ASSIGNERS[key]?.(at, value);
};

const parseYamlAt = (lines: string[]): TapDiagnostic["at"] | undefined => {
  const atIndex = lines.findIndex((line) => /^(\s*)at:\s*$/.test(line));
  if (atIndex === -1) return;

  const atIndent = leadingWhitespaceLength(lines[atIndex] ?? "");
  const at: NonNullable<TapDiagnostic["at"]> = {};
  for (const line of lines.slice(atIndex + 1)) {
    if (line.trim() && leadingWhitespaceLength(line) <= atIndent) break;
    const match = line.match(/^\s*(file|line|column):\s*(.*)$/);
    if (!match) continue;
    assignAtField(at, match[1] ?? "", parseYamlScalar(match[2] ?? ""));
  }
  return at;
};

const parseYamlTapDiagnostic = (text: string): TapDiagnostic | undefined => {
  const lines = text.split(/\r?\n/);
  const diagnostic: TapDiagnostic = {};

  const message = parseYamlMessage(lines);
  if (message !== undefined) diagnostic.message = message;

  const at = parseYamlAt(lines);
  if (at !== undefined) diagnostic.at = at;

  return diagnostic.message || diagnostic.at ? diagnostic : undefined;
};

export const parseTapDiagnosticBlock = (lines: string[]): TapDiagnostic => {
  const text = stripCommonIndent(lines).trimEnd();
  const trimmed = text.trim();
  if (!trimmed) {
    return { message: "No TAP diagnostic was emitted for this failure." };
  }

  try {
    return JSON.parse(trimmed) as TapDiagnostic;
  } catch {
    return parseYamlTapDiagnostic(text) ?? { message: text };
  }
};

export const isStepFailureDiagnostic = (diagnostic: TapDiagnostic): boolean =>
  STEP_FAILURE_RE.test((diagnostic.message ?? "").trim());
