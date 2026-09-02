import { mapNotNullish } from "#fp";
import { byLine } from "#scripts/check-report.ts";
import { lineColumnAt } from "#scripts/line-column.ts";
import { parseProgram } from "#scripts/parse-program.ts";
import { blankSpans } from "#scripts/typescript-lex.ts";

export interface Alias {
  name: string;
  target: string;
}

export interface ImportLine {
  line: number;
  namesOnly: boolean;
  reExport: boolean;
  specifier: string;
  typeOnly: boolean;
}

export interface ImportIssue {
  line: number;
  message: string;
}

const isFolder = (alias: Alias): boolean => alias.name.endsWith("/");

/** Translate between alias names and targets while folder aliases keep suffixes. */
const across =
  (
    from: keyof Alias,
    to: keyof Alias,
  ): ((alias: Alias, text: string) => string | null) =>
  (alias: Alias, text: string): string | null => {
    if (!isFolder(alias)) return text === alias[from] ? alias[to] : null;
    if (!text.startsWith(alias[from])) return null;
    return alias[to] + text.slice(alias[from].length);
  };

const pathFor = across("name", "target");

const nameFor = across("target", "name");

/** Whether people write this alias rather than a JSX transform. */
const isSpellable = (alias: Alias): boolean =>
  isFolder(alias) || !alias.name.includes("/");

const spellingFor = (alias: Alias, path: string): string | null =>
  isSpellable(alias) ? nameFor(alias, path) : null;

/** Find the best non-null answer from the alias table. */
const bestFromAliases = <T>(
  aliases: Alias[],
  answerFrom: (alias: Alias) => T | null,
  beats: (answer: T, best: T) => boolean,
): T | null => {
  let best: T | null = null;
  for (const alias of aliases) {
    const answer = answerFrom(alias);
    if (answer === null) continue;
    if (best === null || beats(answer, best)) best = answer;
  }
  return best;
};

/** Resolve a specifier through its longest matching alias. */
export const resolveSpecifier = (
  aliases: Alias[],
  specifier: string,
): string | null => {
  const best = bestFromAliases(
    aliases,
    (alias) => {
      const path = pathFor(alias, specifier);
      return path === null ? null : { length: alias.name.length, path };
    },
    (answer, best) => answer.length > best.length,
  );
  return best === null ? null : best.path;
};

/** Choose the shortest alias, then the first in alphabetical order. */
export const bestSpelling = (aliases: Alias[], path: string): string | null =>
  bestFromAliases(
    aliases,
    (alias) => spellingFor(alias, path),
    (spelling, best) =>
      spelling.length < best.length ||
      (spelling.length === best.length && spelling < best),
  );

type ProgramStatement = ReturnType<typeof parseProgram>["body"][number];

const moduleLineFrom = (
  content: string,
  statement: ProgramStatement,
): ImportLine | null => {
  if (statement.type === "ImportDeclaration") {
    const beforeSource = blankSpans(
      content.slice(statement.start, statement.source.start),
      true,
    );
    return {
      line: lineColumnAt(content, statement.start).line,
      namesOnly:
        /\bfrom\s*$/.test(beforeSource) &&
        statement.specifiers.every(({ type }) => type === "ImportSpecifier"),
      reExport: false,
      specifier: statement.source.value,
      typeOnly: statement.importKind === "type",
    };
  }
  if (
    statement.type !== "ExportNamedDeclaration" &&
    statement.type !== "ExportAllDeclaration"
  ) {
    return null;
  }
  if (statement.source === null) return null;
  return {
    line: lineColumnAt(content, statement.start).line,
    namesOnly: false,
    reExport: true,
    specifier: statement.source.value,
    typeOnly: statement.exportKind === "type",
  };
};

export const topLevelImports = (file: string, content: string): ImportLine[] =>
  mapNotNullish((statement: ProgramStatement) =>
    moduleLineFrom(content, statement),
  )(parseProgram(file, content).body);

/** Find named imports that can merge. Namespace imports remain separate. */
const findSplitImports = (imports: ImportLine[]): ImportIssue[] => {
  const bySpecifier = new Map<string, ImportLine[]>();
  for (const entry of imports) {
    if (entry.reExport) continue;
    const found = bySpecifier.get(entry.specifier);
    if (found) found.push(entry);
    else bySpecifier.set(entry.specifier, [entry]);
  }
  const issues: ImportIssue[] = [];
  for (const [specifier, group] of bySpecifier) {
    if (group.length < 2 || !group.every((entry) => entry.namesOnly)) continue;
    issues.push({
      line: group[1]!.line,
      message: `imports "${specifier}" again — merge into one statement, marking the type-only names with an inline \`type\``,
    });
  }
  return issues;
};

const findLongSpellings = (
  aliases: Alias[],
  imports: ImportLine[],
): ImportIssue[] => {
  const issues: ImportIssue[] = [];
  for (const entry of imports) {
    const path = resolveSpecifier(aliases, entry.specifier);
    if (path === null) continue;
    const best = bestSpelling(aliases, path);
    if (best === null || best === entry.specifier) continue;
    issues.push({
      line: entry.line,
      message: `imports "${entry.specifier}" — write "${best}" instead`,
    });
  }
  return issues;
};

export const findImportIssues = (
  file: string,
  content: string,
  aliases: Alias[],
): ImportIssue[] => {
  const imports = topLevelImports(file, content);
  return [
    ...findSplitImports(imports),
    ...findLongSpellings(aliases, imports),
  ].sort(byLine);
};

export const formatIssue = (file: string, issue: ImportIssue): string =>
  `${file}:${issue.line} ${issue.message}`;
