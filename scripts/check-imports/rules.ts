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

/** Where one import statement sits, and what shape it has. */
export interface ImportLine {
  line: number;
  /** True when the statement only brings in names inside `{ }`. */
  namesOnly: boolean;
  specifier: string;
}

export interface ImportIssue {
  line: number;
  message: string;
}

const isFolder = (alias: Alias): boolean => alias.name.endsWith("/");

/** The file an alias points at, or null when the alias does not cover it. */
const pathFor = (alias: Alias, specifier: string): string | null => {
  if (!isFolder(alias)) return specifier === alias.name ? alias.target : null;
  if (!specifier.startsWith(alias.name)) return null;
  return alias.target + specifier.slice(alias.name.length);
};

/**
 * Whether an alias is one we ask people to write. A folder alias and a one-word
 * alias such as `#types` both are. `#jsx/jsx-runtime` is not: it names a module
 * without its extension for the JSX transform to emit, and no hand-written
 * import spells a module that way.
 */
const isSpellable = (alias: Alias): boolean =>
  isFolder(alias) || !alias.name.includes("/");

/** How an alias would spell `path`, or null when it cannot reach it. */
const spellingFor = (alias: Alias, path: string): string | null => {
  if (!isSpellable(alias)) return null;
  if (!isFolder(alias)) return path === alias.target ? alias.name : null;
  if (!path.startsWith(alias.target)) return null;
  return alias.name + path.slice(alias.target.length);
};

/**
 * The file `specifier` names. Longest alias wins, the way the runtime resolves
 * it, so `#db/x.ts` beats the broader `#shared/` reading of the same path.
 */
export const resolveSpecifier = (
  aliases: Alias[],
  specifier: string,
): string | null => {
  let best: { length: number; path: string } | null = null;
  for (const alias of aliases) {
    const path = pathFor(alias, specifier);
    if (path === null) continue;
    if (best === null || alias.name.length > best.length) {
      best = { length: alias.name.length, path };
    }
  }
  return best === null ? null : best.path;
};

/**
 * The one spelling we want for `path`: the shortest, then the alphabetically
 * first so two equally short aliases still give one answer.
 */
export const bestSpelling = (aliases: Alias[], path: string): string | null => {
  let best: string | null = null;
  for (const alias of aliases) {
    const spelling = spellingFor(alias, path);
    if (spelling === null) continue;
    if (
      best === null ||
      spelling.length < best.length ||
      (spelling.length === best.length && spelling < best)
    )
      best = spelling;
  }
  return best;
};

/**
 * Every top-level import in `content`. A line that starts in column 0 is the
 * only one that counts, so an example import quoted inside a string is not
 * mistaken for the real thing. The module name is read from the line that ends
 * the statement, which is the line carrying `from`, and the shape from the line
 * that opens it.
 */
export const topLevelImports = (content: string): ImportLine[] => {
  const found: ImportLine[] = [];
  let open: { head: string; line: number } | null = null;
  for (const [index, line] of content.split("\n").entries()) {
    if (open === null && /^import[\s{"']/.test(line)) {
      open = { head: line, line: index + 1 };
    }
    if (open === null) continue;
    const isEnd =
      /from\s+["']/.test(line) || /^import\s+["'][^"']*["']/.test(line);
    if (!isEnd) continue;
    const specifier = line.match(/from\s+["']([^"']+)["']/)?.[1];
    if (specifier !== undefined) {
      found.push({
        line: open.line,
        namesOnly: /^import\s+(type\s+)?\{/.test(open.head),
        specifier,
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
