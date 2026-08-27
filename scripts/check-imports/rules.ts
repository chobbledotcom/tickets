/**
 * Pure rules for the import checks. Everything here works on text plus the
 * alias table, so the IO shell in `run.ts` only has to find the files.
 */

import { byLine } from "#scripts/check-report.ts";

/** One `#` alias from the import map. A name ending in `/` covers a folder. */
export interface Alias {
  name: string;
  target: string;
}

/** Where one statement that names a module sits, and what shape it has. */
export interface ImportLine {
  line: number;
  /** True when the statement only brings in names inside `{ }`. */
  namesOnly: boolean;
  /** True when the statement re-exports rather than imports. Both load the
   *  module at run time, but only two imports can merge into one statement. */
  reExport: boolean;
  specifier: string;
  /** True when the statement opens `import type` or `export type`, so nothing
   *  it names survives to run time. A statement whose every name instead
   *  carries an inline `type` is erased too, and reads here as a run-time
   *  import. */
  typeOnly: boolean;
}

export interface ImportIssue {
  line: number;
  message: string;
}

const isFolder = (alias: Alias): boolean => alias.name.endsWith("/");

/**
 * Read `text` on one side of an alias and write it out on the other. A folder
 * alias keeps whatever followed the prefix; a plain alias only matches the
 * whole thing. Reading a specifier and writing a spelling are this one
 * translation, run in opposite directions.
 */
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

/** The file an alias points at, or null when the alias does not cover it. */
const pathFor = across("name", "target");

const nameFor = across("target", "name");

/**
 * Whether an alias is one we ask people to write. A folder alias and a one-word
 * alias such as `#types` both are. `#jsx/jsx-runtime` is not: it names a module
 * without its extension for the JSX transform to emit, and no hand-written
 * import spells a module that way.
 */
const isSpellable = (alias: Alias): boolean =>
  isFolder(alias) || !alias.name.includes("/");

/** How an alias would spell `path`, or null when it cannot reach it. */
const spellingFor = (alias: Alias, path: string): string | null =>
  isSpellable(alias) ? nameFor(alias, path) : null;

/**
 * The winning answer the alias table gives, or null when no alias reaches.
 * `answerFrom` reads one alias, and `beats` says which of two answers wins.
 * Both lookups below are this one walk over the table.
 */
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

/**
 * The file `specifier` names. Longest alias wins, the way the runtime resolves
 * it, so `#db/x.ts` beats the broader `#shared/` reading of the same path.
 */
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

/**
 * The one spelling we want for `path`: the shortest, then the alphabetically
 * first so two equally short aliases still give one answer.
 */
export const bestSpelling = (aliases: Alias[], path: string): string | null =>
  bestFromAliases(
    aliases,
    (alias) => spellingFor(alias, path),
    (spelling, best) =>
      spelling.length < best.length ||
      (spelling.length === best.length && spelling < best),
  );

/** Where a statement that names a module opens. A re-export names one as
 * surely as an import does, and loads it just the same. */
const OPENS_A_MODULE_STATEMENT = /^(?:import[\s{"']|export\s+(?:type\s+)?[{*])/;

/**
 * Every top-level statement in `content` that names a module — an import or a
 * re-export. A line that starts in column 0 is the only one that counts, so an
 * example import quoted inside a string is not mistaken for the real thing. The
 * module name is read from the line that ends the statement, which is the line
 * carrying `from`, and the shape from the line that opens it. A statement that
 * ends without a `from`, such as `export { getRawCached };`, names no module
 * and is dropped.
 */
export const topLevelImports = (content: string): ImportLine[] => {
  const found: ImportLine[] = [];
  let open: { head: string; line: number } | null = null;
  for (const [index, line] of content.split("\n").entries()) {
    if (open === null && OPENS_A_MODULE_STATEMENT.test(line)) {
      open = { head: line, line: index + 1 };
    }
    if (open === null) continue;
    const isEnd =
      /from\s+["']/.test(line) ||
      /^import\s+["'][^"']*["']/.test(line) ||
      /;\s*$/.test(line);
    if (!isEnd) continue;
    // A side-effect `import "./x.ts"` names its module without a `from`, and
    // loads it for what it does rather than for what it hands back.
    const specifier =
      line.match(/from\s+["']([^"']+)["']/)?.[1] ??
      line.match(/^import\s+["']([^"']+)["']/)?.[1];
    if (specifier !== undefined) {
      found.push({
        line: open.line,
        namesOnly: /^import\s+(type\s+)?\{/.test(open.head),
        reExport: /^export\b/.test(open.head),
        specifier,
        typeOnly: /^(?:import|export)\s+type\b/.test(open.head),
      });
    }
    open = null;
  }
  return found;
};

/**
 * Imports of one module split across two statements. Only a pair that both
 * bring in names can merge, so a namespace import beside named ones is left
 * alone: it reads the whole module on purpose.
 */
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

/** Imports that spell a module a longer way than its own alias allows. */
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

/** Everything wrong with one file's imports, in line order. */
export const findImportIssues = (
  content: string,
  aliases: Alias[],
): ImportIssue[] => {
  const imports = topLevelImports(content);
  return [
    ...findSplitImports(imports),
    ...findLongSpellings(aliases, imports),
  ].sort(byLine);
};

export const formatIssue = (file: string, issue: ImportIssue): string =>
  `${file}:${issue.line} ${issue.message}`;
