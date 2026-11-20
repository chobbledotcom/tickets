import { readTlaSource } from "#scripts/tla/source.ts";
import type { TlaToken } from "#scripts/tla-cpd/lex.ts";

/** One top-level operator, with the source text that defines it. */
export type TlaDefinition = {
  readonly name: string;
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** Identifiers that occur in the body. Callers keep the known names. */
  readonly references: readonly string[];
};

/** One maintained TLA module, read without the full TLA grammar. */
export type TlaModule = {
  readonly module: string;
  readonly content: string;
  readonly definitions: ReadonlyMap<string, TlaDefinition>;
  readonly extends: readonly string[];
};

type DefinitionStart = {
  readonly nameIndex: number;
  readonly equalityIndex: number;
};

const afterParameters = (tokens: readonly TlaToken[], from: number): number => {
  if (tokens[from]?.text !== "(") return from;
  let depth = 0;
  for (let cursor = from; cursor < tokens.length; cursor++) {
    const text = tokens[cursor]!.text;
    if (text === "(") depth++;
    if (text !== ")") continue;
    depth--;
    if (depth === 0) return cursor + 1;
  }
  return from;
};

const equalityIndex = (
  tokens: readonly TlaToken[],
  index: number,
): number | undefined => {
  const token = tokens[index]!;
  if (token.kind !== "identifier" || token.start.column !== 1) return;
  const cursor = afterParameters(tokens, index + 1);
  return tokens[cursor]?.text === "==" ? cursor : undefined;
};

const definitionStarts = (tokens: readonly TlaToken[]): DefinitionStart[] => {
  const starts: DefinitionStart[] = [];
  for (let index = 0; index + 1 < tokens.length; index++) {
    const equality = equalityIndex(tokens, index);
    if (equality !== undefined) {
      starts.push({ equalityIndex: equality, nameIndex: index });
    }
  }
  return starts;
};

const referencesBetween = (
  tokens: readonly TlaToken[],
  from: number,
  end: number,
): string[] => {
  const references: string[] = [];
  for (let cursor = from; cursor < tokens.length; cursor++) {
    const current = tokens[cursor]!;
    if (current.start.position >= end) break;
    if (current.kind === "identifier") references.push(current.text);
  }
  return references;
};

const withoutTrailingNotes = (text: string): string => {
  const lines = text.split("\n");
  let body = lines.length;
  while (body > 0 && /^\s*(?:\\\*|\(\*|\*\))/.test(lines[body - 1]!)) body--;
  if (body === lines.length) return text;
  while (body > 0 && lines[body - 1]!.trim() === "") body--;
  return lines.slice(0, body).join("\n");
};

/** Read the top-level operators and the EXTENDS names of one module.
 *
 * A top-level operator starts at column one. The body ends at the next
 * top-level operator. The checker still decides the full TLA grammar. */
export const readTlaModule = (file: string, content: string): TlaModule => {
  const source = readTlaSource(file, content);
  const tokens = source.tokens;
  const starts = definitionStarts(tokens);
  const endMarker = tokens.at(-1)!;
  const definitions = new Map<string, TlaDefinition>();
  starts.forEach((start, position) => {
    const token = tokens[start.nameIndex]!;
    const next = starts[position + 1];
    const end =
      next === undefined
        ? endMarker.start.position
        : tokens[next.nameIndex]!.start.position;
    definitions.set(token.text, {
      end,
      line: token.start.line,
      name: token.text,
      references: referencesBetween(tokens, start.equalityIndex + 1, end),
      start: token.start.position,
      text: withoutTrailingNotes(
        content.slice(token.start.position, end).trimEnd(),
      ),
    });
  });
  return {
    content,
    definitions,
    extends: extendsNames(file, content),
    module: source.moduleName,
  };
};

const extendsNames = (file: string, content: string): string[] => {
  const names: string[] = [];
  for (const match of content.matchAll(/^EXTENDS(?:[ \t]+(.*))?$/gm)) {
    const line = (match[1] ?? "").trim();
    if (line === "") continue;
    if (line.endsWith(",")) {
      throw new Error(`${file}: A multi-line EXTENDS is not supported.`);
    }
    for (const name of line.split(",")) {
      const trimmed = name.trim();
      if (trimmed !== "") names.push(trimmed);
    }
  }
  return [...new Set(names)];
};

/** Join the operators that this model defines and the operators that its
 *  local helper modules extend. The model itself wins a repeated name. */
export const definitionIndex = (
  model: TlaModule,
  helpers: readonly TlaModule[],
): ReadonlyMap<string, TlaDefinition> => {
  const index = new Map<string, TlaDefinition>();
  for (const helper of helpers) {
    for (const [name, definition] of helper.definitions) {
      if (!index.has(name)) index.set(name, definition);
    }
  }
  for (const [name, definition] of model.definitions) {
    index.set(name, definition);
  }
  return index;
};
