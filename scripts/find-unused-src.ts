/**
 * Finds src/ exports that are only used in test/ files but never in other src/ files.
 *
 * Three checks:
 * 1. File-level: src/ files imported by test/ but never by other src/ files
 * 2. Export-level: individual named exports from src/ only used in test/
 * 3. Dead code: src/ files not imported by anything
 *
 * Handles both static imports and dynamic `await import("...")` calls.
 * Also scans scripts/ for build entry points.
 *
 * Usage: deno task find-unused-src
 */

import { dirname, relative, resolve } from "@std/path";
import { flatMap } from "#fp";
import { collectSourceFiles } from "./walk-files.ts";

const ROOT = resolve(import.meta.dirname!, "..");

// Read and parse deno.json import map
const denoConfig = JSON.parse(
  await Deno.readTextFile(resolve(ROOT, "deno.json")),
);
const importMapRaw: Record<string, string> = denoConfig.imports ?? {};

// Build alias-to-path mapping for local aliases
const aliasMap: { alias: string; path: string }[] = [];
for (const [alias, target] of Object.entries(importMapRaw)) {
  if (typeof target === "string" && target.startsWith("./")) {
    aliasMap.push({ alias, path: target.replace(/^\.\//, "") });
  }
}
// Sort by longest alias first so more specific aliases match first
aliasMap.sort((a, b) => b.alias.length - a.alias.length);

/** Resolve an import specifier to a relative file path (from project root) */
/** Try to resolve a specifier via the alias map */
function resolveAlias(specifier: string): string | null {
  for (const { alias, path: aliasPath } of aliasMap) {
    if (alias.endsWith("/") && specifier.startsWith(alias)) {
      return aliasPath + specifier.slice(alias.length);
    }
    if (specifier === alias) return aliasPath;
  }
  return null;
}

function resolveImport(specifier: string, fromFile: string): string | null {
  const aliased = resolveAlias(specifier);
  if (aliased) return aliased;

  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const fromDir = dirname(fromFile);
    const resolved = resolve(ROOT, fromDir, specifier);
    return relative(ROOT, resolved);
  }

  return null;
}

/** Read a project-relative source file as UTF-8 text. */
const readSource = async (filePath: string): Promise<string> =>
  Deno.readTextFile(resolve(ROOT, filePath));

/** Split a comma-separated `a, b as c` list into bare names, dropping aliases. */
const splitAliasedNames = (raw: string): string[] =>
  raw
    .split(",")
    .map((n: string) =>
      n
        .trim()
        .replace(/\s+as\s+\w+/, "")
        .trim(),
    )
    .filter(Boolean);

/** Collect every project-relative .ts/.tsx file beneath `dir`, sorted. */
const collectTreeFiles = async (dir: string): Promise<string[]> =>
  (await collectSourceFiles(resolve(ROOT, dir))).map((file) =>
    relative(ROOT, file),
  );

/** Collect one `{ names, specifier }` entry per match of an import regex;
 * `read` says which capture groups carry the named imports and the specifier. */
const importsFromMatches = (
  content: string,
  regex: RegExp,
  read: (match: RegExpMatchArray) => {
    namedImports: string;
    specifier: string;
  },
): { specifier: string; names: string[] }[] =>
  [...content.matchAll(regex)].map((match) => {
    const { namedImports, specifier } = read(match);
    return { names: splitAliasedNames(namedImports), specifier };
  });

// Static imports/exports:
//   import { a, b } from "specifier"
//   import name from "specifier"
//   import * as name from "specifier"
//   import "specifier"
//   import type { a } from "specifier"
//   export { a } from "specifier"
const staticRegex =
  /(?:import|export)\s+(?:type\s+)?(?:\{([^}]*)\}|(\*\s+as\s+\w+)|\w+)?\s*(?:,\s*\{([^}]*)\})?\s*(?:from\s+)?["']([^"']+)["']/g;

// Dynamic imports:
//   const { a, b } = await import("specifier")
//   await import("specifier")
//   () => import("specifier")
const dynamicRegex =
  /(?:const\s+\{([^}]*)\}\s*=\s*(?:await\s+)?)?import\(\s*["']([^"']+)["']\s*\)/g;

/** Extract both static and dynamic import specifiers from a file */
async function extractImports(
  filePath: string,
): Promise<{ specifier: string; names: string[] }[]> {
  const content = await readSource(filePath);
  return [
    ...importsFromMatches(content, staticRegex, (match) => ({
      namedImports: (match[1] || "") + (match[3] || ""),
      specifier: match[4]!,
    })),
    ...importsFromMatches(content, dynamicRegex, (match) => ({
      namedImports: match[1] || "",
      specifier: match[2]!,
    })),
  ];
}

/** Patterns that match named export declarations */
const EXPORT_PATTERNS: RegExp[] = [
  /export\s+function\s+(\w+)/g,
  /export\s+(?:const|let|var)\s+(\w+)/g,
  /export\s+class\s+(\w+)/g,
  /export\s+(?:type|interface)\s+(\w+)/g,
  /export\s+enum\s+(\w+)/g,
];

/** Extract names from `export { a, b as c }` blocks (not re-exports) */
const extractBraceExports = (content: string): string[] =>
  flatMap((m: RegExpMatchArray) => splitAliasedNames(m[1]!))([
    ...content.matchAll(/export\s+\{([^}]+)\}(?!\s*from)/g),
  ]);

/** Extract exported names from a file */
async function extractExports(filePath: string): Promise<string[]> {
  const content = await readSource(filePath);
  const exports: string[] = [];

  for (const pattern of EXPORT_PATTERNS) {
    for (const m of content.matchAll(pattern)) {
      exports.push(m[1]!);
    }
  }
  exports.push(...extractBraceExports(content));
  if (/export\s+default\s/.test(content)) exports.push("default");

  return [...new Set(exports)];
}

// ---- Main analysis ----

console.log("Scanning codebase...\n");

const srcFiles = (await collectTreeFiles("src")).filter(
  (f) => !f.startsWith("src/ui/static/") && !f.endsWith(".d.ts"),
);
// Test utilities now live under test/ (test/test-utils/), so they are part of
// the test file set rather than a separate src group.
const testFiles = await collectTreeFiles("test");
const scriptFiles = await collectTreeFiles("scripts");
const allFiles = [...srcFiles, ...testFiles, ...scriptFiles];

// Known entry points that are used outside the import graph
const entryPoints = new Set([
  "src/index.ts", // deno task start
  "src/edge.ts", // esbuild entry for Bunny CDN
  "src/fp.ts", // import map root alias
  "src/doc.ts", // deno doc generation
  "src/shared/jsx/jsx-dev-runtime.ts", // jsxImportSource compiler config
]);

// Docs files are used by deno doc via src/doc.ts - mark as known
const docsFiles = srcFiles.filter((f) => f.startsWith("src/docs/"));
for (const f of docsFiles) entryPoints.add(f);

type ImportInfo = { file: string; names: string[] };
const importedBySrc = new Map<string, ImportInfo[]>();
const importedByTest = new Map<string, ImportInfo[]>();

/** The src/ and test/ importers recorded for one source file. */
const importersOf = (
  srcFile: string,
): { src: ImportInfo[]; test: ImportInfo[] } => ({
  src: importedBySrc.get(srcFile) ?? [],
  test: importedByTest.get(srcFile) ?? [],
});

// Files eligible for the "imported only by tests" and "dead code" checks:
// entry points and browser-only client code are expected to sit outside the
// module graph, so they are never reported.
const candidateSrcFiles = srcFiles.filter(
  (f) => !entryPoints.has(f) && !f.startsWith("src/ui/client/"),
);

/** True when `srcFile` is imported by neither src/ nor test/ files. */
const isNeverImported = (srcFile: string): boolean => {
  const { src, test } = importersOf(srcFile);
  return src.length === 0 && test.length === 0;
};

for (const file of allFiles) {
  const imports = await extractImports(file);
  for (const { specifier, names } of imports) {
    const resolved = resolveImport(specifier, file);
    if (!resolved?.startsWith("src/")) continue;

    let target = resolved;
    const allSrcFiles = srcFiles;
    if (!allSrcFiles.includes(target)) {
      if (allSrcFiles.includes(`${target}.ts`)) target = `${target}.ts`;
      else if (allSrcFiles.includes(`${target}.tsx`)) target = `${target}.tsx`;
      else if (allSrcFiles.includes(`${target}/index.ts`)) {
        target = `${target}/index.ts`;
      }
    }

    const info: ImportInfo = { file, names };

    if (file.startsWith("test/")) {
      if (!importedByTest.has(target)) importedByTest.set(target, []);
      importedByTest.get(target)!.push(info);
    } else if (file.startsWith("src/") || file.startsWith("scripts/")) {
      if (!importedBySrc.has(target)) importedBySrc.set(target, []);
      importedBySrc.get(target)!.push(info);
    }
  }
}

/** Print one check's banner heading. */
const printHeading = (title: string): void => {
  const bar = "═".repeat(63);
  console.log(bar);
  console.log(`  ${title}`);
  console.log(`${bar}\n`);
};

/** Close a check's section: "None found." or its total, e.g. "Total: 3 file(s)".
 * `prefix` carries the dead-code check's extra blank line before its total. */
const printTotal = (count: number, unit: string, prefix = ""): void => {
  console.log(
    count === 0 ? "  None found.\n" : `${prefix}  Total: ${count} ${unit}(s)\n`,
  );
};

// ---- Check 1: Files only imported from tests ----
printHeading("FILES imported by test/ but NEVER by other src/ files");

let fileCount = 0;
for (const srcFile of candidateSrcFiles) {
  const { src: srcImporters, test: testImporters } = importersOf(srcFile);
  const testOnly = srcImporters.length === 0 && testImporters.length > 0;
  if (testOnly) {
    fileCount++;
    const testFileList = [...new Set(testImporters.map((i) => i.file))];
    console.log(`  ${srcFile}`);
    for (const tf of testFileList) {
      console.log(`    <- ${tf}`);
    }
    console.log();
  }
}

printTotal(fileCount, "file");

// ---- Check 2: Individual exports only used in tests ----
printHeading("EXPORTS used in test/ but NEVER in other src/ files");

let exportCount = 0;
for (const srcFile of srcFiles) {
  const { src: srcImporters, test: testImporters } = importersOf(srcFile);

  if (srcImporters.length === 0) continue;
  if (testImporters.length === 0) continue;

  const fileExports = await extractExports(srcFile);
  if (fileExports.length === 0) continue;

  const namesUsedBySrc = new Set(srcImporters.flatMap((i) => i.names));
  const namesUsedByTest = new Set(testImporters.flatMap((i) => i.names));

  const testOnlyExports = fileExports.filter(
    (name) => !namesUsedBySrc.has(name) && namesUsedByTest.has(name),
  );

  if (testOnlyExports.length > 0) {
    exportCount += testOnlyExports.length;
    console.log(`  ${srcFile}:`);
    for (const name of testOnlyExports) {
      const usedIn = testImporters
        .filter((i) => i.names.includes(name))
        .map((i) => i.file);
      console.log(`    ${name}`);
      for (const tf of usedIn) {
        console.log(`      <- ${tf}`);
      }
    }
    console.log();
  }
}

printTotal(exportCount, "export");

// ---- Check 3: Files not imported by anything (dead code) ----
printHeading("FILES not imported by anything (potential dead code)");

let deadCount = 0;
for (const srcFile of candidateSrcFiles) {
  if (!isNeverImported(srcFile)) continue;
  deadCount++;
  console.log(`  ${srcFile}`);
}

printTotal(deadCount, "file", "\n");
