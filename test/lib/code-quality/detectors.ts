/**
 * Pure detection logic for the "code quality" test suite.
 *
 * This module exists so the rules enforced by `test/lib/code-quality.test.ts`
 * can be exercised directly with crafted fixtures — feeding each detector a
 * known-bad input and asserting it fires, and a known-good input and asserting
 * it stays quiet. The integration test that scans the real `src/`+`test/` tree
 * only ever asserts "no violations" against an already-clean codebase, so on its
 * own it cannot tell a working detector apart from a broken one (mutation
 * testing scored it 35.8%). Splitting the pure logic out here, behind explicit
 * inputs, makes every branch reachable and every regression catchable.
 *
 * Everything here is a pure function of its arguments (the file lists, contents,
 * and policy allow-lists are passed in by the caller), with the lone exception
 * of `getAllFilesWithExt`, which walks the filesystem.
 */

import { join } from "node:path";

/* -------------------------------------------------------------------------- *
 * File discovery                                                             *
 * -------------------------------------------------------------------------- */

/** Recursively collect every file under `dir` whose name ends with `ext`. */
export const getAllFilesWithExt = async (
  dir: string,
  ext: string,
): Promise<string[]> => {
  const files: string[] = [];

  for await (const entry of Deno.readDir(dir)) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory) {
      files.push(...(await getAllFilesWithExt(fullPath, ext)));
    } else if (entry.name.endsWith(ext)) {
      files.push(fullPath);
    }
  }

  return files;
};

/* -------------------------------------------------------------------------- *
 * No in-memory state: module-level Map/Set should be in the database         *
 * -------------------------------------------------------------------------- */

/**
 * Patterns that indicate in-memory state storage at module level.
 * These should be stored in the database instead to survive restarts.
 */
export const FORBIDDEN_PATTERNS = [
  {
    description: "Module-level Map (use database instead)",
    pattern: /^(?:export\s+)?(?:const|let)\s+\w+\s*=\s*new\s+Map\s*[<(]/m,
  },
  {
    description: "Module-level Set (use database instead)",
    pattern: /^(?:export\s+)?(?:const|let)\s+\w+\s*=\s*new\s+Set\s*[<(]/m,
  },
  {
    description: "Module-level typed Map (use database instead)",
    pattern: /^(?:export\s+)?(?:const|let)\s+\w+\s*:\s*Map\s*</m,
  },
  {
    description: "Module-level typed Set (use database instead)",
    pattern: /^(?:export\s+)?(?:const|let)\s+\w+\s*:\s*Set\s*</m,
  },
];

/**
 * Violations of the in-memory-state rule for a single source file. `allowedFiles`
 * is the src-relative allow-list of files permitted to hold module-level state.
 */
export const findInMemoryStateViolations = (
  relativePath: string,
  content: string,
  allowedFiles: string[],
): string[] => {
  if (allowedFiles.includes(relativePath)) return [];
  const violations: string[] = [];
  for (const { pattern, description } of FORBIDDEN_PATTERNS) {
    if (pattern.test(content)) {
      violations.push(`${relativePath}: ${description}`);
    }
  }
  return violations;
};

/* -------------------------------------------------------------------------- *
 * DB writes must go through the client choke point                           *
 * -------------------------------------------------------------------------- */

export const RAW_DB_PATTERN = /getDb\(\)\.(?:execute|batch)\s*\(/;

/**
 * The violation message for a file that calls `getDb().execute/.batch` directly,
 * or `null` when the file is clean or on the `allowed` prefix list.
 */
export const findRawDbViolation = (
  relativePath: string,
  content: string,
  allowed: string[],
): string | null => {
  if (allowed.some((prefix) => relativePath.startsWith(prefix))) return null;
  if (RAW_DB_PATTERN.test(content)) {
    return `${relativePath}: use execute()/queryOne()/queryAll()/executeBatch() from #shared/db/client.ts instead of getDb().execute/.batch`;
  }
  return null;
};

/* -------------------------------------------------------------------------- *
 * Line-level rules: aliasing, module-level let, .then()                       *
 * -------------------------------------------------------------------------- */

/**
 * Pattern to detect function/variable aliasing at module level.
 * Forces use of `import { x as y }` instead of post-import aliasing.
 * Example violation: const myFunc = someImportedFunc;
 * Only matches identifiers (starts with letter/underscore), not literals.
 */
export const ALIASING_PATTERN =
  /^(?:export\s+)?const\s+(\w+)\s*=\s*([a-zA-Z_]\w*)\s*;?\s*(?:\/\/.*)?$/;

/** A single line's aliasing violation, or `null` when the line is fine. */
export const detectAliasing = (
  relativePath: string,
  line: string,
  lineNum: number,
): string | null => {
  const match = line.match(ALIASING_PATTERN);
  if (!match) return null;
  const [, varName, value] = match;
  return `${relativePath}:${lineNum}: const ${varName} = ${value} (use import { ${value} as ${varName} } instead)`;
};

/** Module-level `let` / `export let` (should be `const` with once()/lazyRef()). */
export const MODULE_LET_PATTERN = /^(export\s+)?let\s+/;

/** A single line's module-level-let violation, or `null`. */
export const detectModuleLevelLet = (
  relativePath: string,
  line: string,
  lineNum: number,
): string | null => {
  if (!line.match(MODULE_LET_PATTERN)) return null;
  return `${relativePath}:${lineNum}: ${line.slice(
    0,
    50,
  )}... (use const with once()/lazyRef())`;
};

/**
 * Pattern to detect `.then()` usage — prefer async/await. Non-global so `.test()`
 * is stateless (the global form needed a `lastIndex` reset around every call).
 */
export const THEN_PATTERN = /\.then\s*\(/;

/** A single line's `.then()` violation, or `null`. */
export const detectThenUsage = (
  relativePath: string,
  line: string,
  lineNum: number,
): string | null => {
  if (!THEN_PATTERN.test(line)) return null;
  return `${relativePath}:${lineNum}: ${line
    .trim()
    .slice(0, 50)}... (use async/await instead)`;
};

/* -------------------------------------------------------------------------- *
 * No test-only exports                                                       *
 * -------------------------------------------------------------------------- */

/**
 * Patterns to extract exported symbols from source files.
 * Only captures direct exports, not re-exports.
 */
export const EXPORT_PATTERNS = [
  // export const/let name = ...
  /^export\s+(?:const|let)\s+(\w+)/gm,
  // export function name(...) or export async function name(...)
  /^export\s+(?:async\s+)?function\s+(\w+)/gm,
  // export class name
  /^export\s+class\s+(\w+)/gm,
];

/** Pattern to detect re-export statements (export { x } from "y") */
export const RE_EXPORT_PATTERN = /^export\s+\{[^}]+\}\s+from\s+['"]/m;

/** Every directly-exported symbol name declared in `content`. */
export const extractExports = (content: string): string[] => {
  const exports: string[] = [];

  for (const pattern of EXPORT_PATTERNS) {
    // No lastIndex reset is needed: String.prototype.matchAll clones the regex
    // and never advances the original's lastIndex, so it stays 0 between calls.
    // Group 1 is the `(\w+)` name, always present and non-empty on a match.
    for (const match of content.matchAll(pattern)) {
      exports.push(match[1]!.trim());
    }
  }

  return exports;
};

/**
 * Whether `symbolName` is referenced within `content` (beyond its own export
 * definition). Looks for calls (`name(`), property access (`name.`), object
 * shorthand, type position, or as the trailing entry of an object literal.
 */
export const isUsedInSameFile = (
  symbolName: string,
  content: string,
): boolean => {
  const lines = content.split("\n");
  let usageCount = 0;

  for (const line of lines) {
    // Skip the export definition line
    if (
      line.match(
        new RegExp(
          `^export\\s+.*(const|let|function|async).*\\b${symbolName}\\b\\s*[=({]`,
        ),
      )
    ) {
      continue;
    }
    // Count usages: function calls, property access, or object shorthand
    // Matches: name(, name., name, (in objects), name: (with type),
    // and name } (when symbol is the trailing entry of an object literal)
    const usagePattern = new RegExp(`\\b${symbolName}\\s*[.(,:}]`);
    if (usagePattern.test(line)) {
      usageCount++;
    }
  }

  return usageCount > 0;
};

/** Whether `content` imports `symbolName` via a named `import { … }` clause. */
export const isSymbolImported = (
  symbolName: string,
  content: string,
): boolean => {
  const importPattern = new RegExp(
    `import\\s*\\{[^}]*\\b${symbolName}\\b[^}]*\\}`,
  );
  return importPattern.test(content);
};

/**
 * Whether `symbolName` (exported from `sourceFile`) is used anywhere in
 * production code: within the same file, imported by another `.ts` source, or
 * imported by a `.tsx` template. `srcContents`/`tsxContents` map an absolute
 * path to its contents.
 */
export const isUsedInProductionCode = (
  symbolName: string,
  sourceFile: string,
  srcContents: Map<string, string>,
  tsxContents: Map<string, string>,
): boolean => {
  // Check if it's used within the same file
  const sourceContent = srcContents.get(sourceFile)!;
  if (isUsedInSameFile(symbolName, sourceContent)) {
    return true;
  }

  // Check other .ts source files
  for (const [file, content] of srcContents) {
    if (file === sourceFile) continue;
    if (isSymbolImported(symbolName, content)) {
      return true;
    }
  }

  // Also check .tsx files as importers
  for (const content of tsxContents.values()) {
    if (isSymbolImported(symbolName, content)) {
      return true;
    }
  }

  return false;
};

/** Whether `symbolName` is imported by any test file in `testContents`. */
export const isUsedInTests = (
  symbolName: string,
  testContents: Map<string, string>,
): boolean => {
  for (const content of testContents.values()) {
    if (isSymbolImported(symbolName, content)) {
      return true;
    }
  }
  return false;
};

/** Whether `content` is primarily a re-export (aggregation) module. */
export const isPrimarilyReExportModule = (content: string): boolean => {
  if (!RE_EXPORT_PATTERN.test(content)) return false;

  const lines = content.split("\n");
  const exportLines = lines.filter((l) => l.startsWith("export"));
  const reExportLines = lines.filter((l) =>
    /^export\s+\{[^}]+\}\s+from\s+['"]/.test(l),
  );
  return reExportLines.length > exportLines.length / 2;
};

/**
 * Test-only-export violations for one source file: exports that are imported by
 * tests but never used in production. `allowedHooks` is the `file:exportName`
 * allow-list of intentional test hooks.
 */
export const findTestOnlyExportViolations = (
  sourceFile: string,
  relativePath: string,
  srcContents: Map<string, string>,
  tsxContents: Map<string, string>,
  testContents: Map<string, string>,
  allowedHooks: string[],
): string[] => {
  const violations: string[] = [];

  const content = srcContents.get(sourceFile)!;
  if (isPrimarilyReExportModule(content)) return violations;

  const exports = extractExports(content);

  for (const exportName of exports) {
    const hookKey = `${relativePath}:${exportName}`;
    if (allowedHooks.includes(hookKey)) continue;

    const usedInProduction = isUsedInProductionCode(
      exportName,
      sourceFile,
      srcContents,
      tsxContents,
    );

    if (!usedInProduction && isUsedInTests(exportName, testContents)) {
      violations.push(
        `${relativePath}: "${exportName}" is exported but only used in tests`,
      );
    }
  }

  return violations;
};

/* -------------------------------------------------------------------------- *
 * Lightweight call-site scanner (used by the redundant-constant-argument      *
 * check). A small hand-written lexer rather than a full AST parser, matching  *
 * the regex-driven style of the rest of this file. It skips comments and      *
 * string/template literals so callee names and argument text are never        *
 * matched inside them. The tokenizer helpers (skipString/skipComment/         *
 * parseArgList) are exported so their index/argument contracts can be unit-   *
 * tested directly — `extractCallSites` alone hides their internal edge cases. *
 * -------------------------------------------------------------------------- */

/** A single call expression discovered in a source file. */
export type CallSite = { name: string; args: string[]; line: number };

/** Keywords that are followed by `(` but are not function calls. */
const NON_CALL_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "with",
  "return",
  "await",
  "typeof",
  "delete",
  "void",
  "new",
  "do",
  "yield",
  "super",
  "constructor",
]);

// These receive a single character the caller has already confirmed is in
// range (every call site is guarded by `< content.length`), so they take a
// definite `string` — no `undefined` guard, which would be a dead branch here.
const isIdentChar = (c: string): boolean => /[\w$]/.test(c);
const isIdentStart = (c: string): boolean => /[A-Za-z_$]/.test(c);
const isWhitespace = (c: string): boolean => /\s/.test(c);

/**
 * Skip a string or template literal starting at the opening quote `start`.
 * Returns the index immediately after the closing quote. Template `${...}`
 * substitutions are skipped wholesale (including nested strings) so a `)` or
 * `,` inside them never leaks into argument parsing.
 */
export const skipString = (content: string, start: number): number => {
  const quote = content[start];
  let j = start + 1;
  while (j < content.length) {
    const c = content[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === quote) return j + 1;
    if (quote === "`" && c === "$" && content[j + 1] === "{") {
      let depth = 1;
      j += 2;
      while (j < content.length && depth > 0) {
        const d = content[j];
        if (d === "{") depth++;
        else if (d === "}") depth--;
        else if (d === '"' || d === "'" || d === "`") {
          j = skipString(content, j);
          continue;
        }
        j++;
      }
      continue;
    }
    j++;
  }
  return j;
};

/** If `i` points at the start of a comment, return the index past it, else i. */
export const skipComment = (content: string, i: number): number => {
  if (content[i] === "/" && content[i + 1] === "/") {
    let j = i;
    while (j < content.length && content[j] !== "\n") j++;
    return j;
  }
  if (content[i] === "/" && content[i + 1] === "*") {
    let j = i + 2;
    while (
      j < content.length &&
      !(content[j] === "*" && content[j + 1] === "/")
    )
      j++;
    return j + 2;
  }
  return i;
};

/**
 * Parse a comma-separated argument list whose opening `(` is at `open`.
 * Returns the trimmed top-level arguments and the index of the closing `)`.
 * Nested brackets, strings and comments are skipped so only top-level commas
 * split arguments.
 */
export const parseArgList = (
  content: string,
  open: number,
): { args: string[]; end: number } => {
  const args: string[] = [];
  let depth = 1;
  let cur = open + 1;
  let p = open + 1;
  while (p < content.length && depth > 0) {
    const skipped = skipComment(content, p);
    if (skipped !== p) {
      p = skipped;
      continue;
    }
    const d = content[p];
    if (d === '"' || d === "'" || d === "`") {
      p = skipString(content, p);
      continue;
    }
    if (d === "(" || d === "[" || d === "{") depth++;
    else if (d === ")" || d === "]" || d === "}") {
      depth--;
      if (depth === 0) {
        args.push(content.slice(cur, p).trim());
        break;
      }
    } else if (d === "," && depth === 1) {
      args.push(content.slice(cur, p).trim());
      cur = p + 1;
    }
    p++;
  }
  return { args: args.filter((a) => a.length > 0), end: p };
};

/** A call site keyed by character offset, before line numbers are resolved. */
type RawCall = { name: string; args: string[]; offset: number };

/**
 * Try to read an identifier-followed-by-`(` call starting at `i`.
 * Returns the parsed call (if any) and the index to continue scanning from.
 */
const readCallAt = (
  content: string,
  i: number,
  prevWord: string,
): { call: RawCall | null; word: string; next: number } => {
  let j = i;
  while (j < content.length && isIdentChar(content[j]!)) j++;
  const word = content.slice(i, j);
  let k = j;
  while (k < content.length && isWhitespace(content[k]!)) k++;
  const isCall =
    content[k] === "(" &&
    !NON_CALL_KEYWORDS.has(word) &&
    prevWord !== "function";
  const call = isCall
    ? { args: parseArgList(content, k).args, name: word, offset: i }
    : null;
  return { call, next: j, word };
};

/** Resolve byte offsets (in ascending order) to 1-based line numbers. */
const resolveLines = (content: string, calls: RawCall[]): CallSite[] => {
  let line = 1;
  let idx = 0;
  return calls.map((call) => {
    for (; idx < call.offset; idx++) if (content[idx] === "\n") line++;
    return { args: call.args, line, name: call.name };
  });
};

/** Extract every `name(...)` call site from a source file. */
export const extractCallSites = (content: string): CallSite[] => {
  const calls: RawCall[] = [];
  let prevWord = "";
  let i = 0;
  while (i < content.length) {
    const c = content[i]!;
    const pastComment = skipComment(content, i);
    if (pastComment !== i) {
      i = pastComment;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(content, i);
      prevWord = "";
      continue;
    }
    if (isIdentStart(c)) {
      const { call, word, next } = readCallAt(content, i, prevWord);
      if (call) calls.push(call);
      prevWord = word;
      i = next;
      continue;
    }
    if (!isWhitespace(c)) prevWord = "";
    i++;
  }
  return resolveLines(content, calls);
};

/* -------------------------------------------------------------------------- *
 * No redundant constant arguments                                            *
 * -------------------------------------------------------------------------- */

/** Minimum number of call sites before a constant argument is suspicious. */
export const MIN_CALL_SITES = 3;

/**
 * Built-in string/array/number methods whose constant literal arguments are
 * idiomatic, not redundant (e.g. `padStart(2, "0")`, `toFixed(2)`). These
 * share names with no application function, so ignoring them is safe.
 */
export const IGNORED_CALLEES = new Set([
  "padStart",
  "padEnd",
  "toFixed",
  "toString",
  "repeat",
  "indexOf",
  "lastIndexOf",
  "charAt",
  "codePointAt",
  "localeCompare",
]);

/**
 * Intentional constant arguments that should not be flagged.
 * Format: "calleeName#position" with a justifying comment.
 */
export const ALLOWED_CONSTANT_ARGS = [
  // Built-in parseInt/Number.parseInt should always pass an explicit radix.
  "parseInt#1",
];

/** True for arguments that are constant literals (not variables/expressions). */
export const isConstantLiteral = (arg: string): boolean => {
  if (/^["'`]/.test(arg)) return true;
  if (/^-?\d/.test(arg)) return true;
  return (
    arg === "true" || arg === "false" || arg === "null" || arg === "undefined"
  );
};

/** A call site enriched with the file it was found in (for reporting). */
export type Site = { args: string[]; file: string; line: number };

/** Describe a single redundant-argument violation for a callee, or `null`. */
export const findRedundantArg = (
  name: string,
  sites: Site[],
): string | null => {
  if (IGNORED_CALLEES.has(name)) return null;
  if (sites.length < MIN_CALL_SITES) return null;
  // Only positions present in *every* call site count as "always passed".
  const sharedArity = Math.min(...sites.map((s) => s.args.length));
  for (let pos = 0; pos < sharedArity; pos++) {
    if (ALLOWED_CONSTANT_ARGS.includes(`${name}#${pos}`)) continue;
    // `pos < sharedArity` guarantees every site has an argument here.
    const values = sites.map((s) => s.args[pos] as string);
    if (!values.every(isConstantLiteral)) continue;
    const first = values[0] as string;
    if (!values.every((v) => v === first)) continue;
    const where = sites
      .map((s) => `${s.file}:${s.line}`)
      .slice(0, 4)
      .join(", ");
    const more = sites.length > 4 ? ", ..." : "";
    return `${name}() arg #${pos} is always ${first} across ${sites.length} calls (${where}${more}) — use a default parameter or constant`;
  }
  return null;
};
