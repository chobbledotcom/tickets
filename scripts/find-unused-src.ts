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

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname!, "..");

// Read and parse deno.json import map
const denoConfig = JSON.parse(
  fs.readFileSync(path.resolve(ROOT, "deno.json"), "utf-8"),
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
    const fromDir = path.dirname(fromFile);
    const resolved = path.resolve(ROOT, fromDir, specifier);
    return path.relative(ROOT, resolved);
  }

  return null;
}

const isTypeScriptFile = (name: string): boolean =>
  name.endsWith(".ts") || name.endsWith(".tsx");

/** List direct entries in a directory, classifying as files or subdirs */
function listEntries(d: string): { dirs: string[]; files: string[] } {
  const dirs: string[] = [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
    const full = path.join(d, entry.name);
    if (entry.isDirectory()) dirs.push(full);
    else if (isTypeScriptFile(entry.name)) {
      files.push(path.relative(ROOT, full));
    }
  }
  return { dirs, files };
}

/** Collect all .ts/.tsx files in a directory recursively */
function collectFiles(dir: string): string[] {
  const fullDir = path.resolve(ROOT, dir);
  if (!fs.existsSync(fullDir)) return [];

  const result: string[] = [];
  const pending = [fullDir];
  while (pending.length > 0) {
    const { dirs, files } = listEntries(pending.pop()!);
    result.push(...files);
    pending.push(...dirs);
  }
  return result.sort();
}

/** Extract both static and dynamic import specifiers from a file */
function extractImports(
  filePath: string,
): { specifier: string; names: string[] }[] {
  const content = fs.readFileSync(path.resolve(ROOT, filePath), "utf-8");
  const imports: { specifier: string; names: string[] }[] = [];

  // Static imports/exports:
  //   import { a, b } from "specifier"
  //   import name from "specifier"
  //   import * as name from "specifier"
  //   import "specifier"
  //   import type { a } from "specifier"
  //   export { a } from "specifier"
  const staticRegex =
    /(?:import|export)\s+(?:type\s+)?(?:\{([^}]*)\}|(\*\s+as\s+\w+)|\w+)?\s*(?:,\s*\{([^}]*)\})?\s*(?:from\s+)?["']([^"']+)["']/g;

  for (const match of content.matchAll(staticRegex)) {
    const namedImports = (match[1] || "") + (match[3] || "");
    const specifier = match[4]!;
    const names = namedImports
      .split(",")
      .map((n: string) =>
        n
          .trim()
          .replace(/\s+as\s+\w+/, "")
          .trim(),
      )
      .filter(Boolean);
    imports.push({ names, specifier });
  }

  // Dynamic imports:
  //   const { a, b } = await import("specifier")
  //   await import("specifier")
  const dynamicRegex =
    /(?:const\s+\{([^}]*)\}\s*=\s*)?await\s+import\(\s*["']([^"']+)["']\s*\)/g;

  for (const match of content.matchAll(dynamicRegex)) {
    const namedImports = match[1] || "";
    const specifier = match[2]!;
    const names = namedImports
      .split(",")
      .map((n: string) =>
        n
          .trim()
          .replace(/\s+as\s+\w+/, "")
          .trim(),
      )
      .filter(Boolean);
    imports.push({ names, specifier });
  }

  return imports;
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
const extractBraceExports = (content: string): string[] => {
  const names: string[] = [];
  for (const m of content.matchAll(/export\s+\{([^}]+)\}(?!\s*from)/g)) {
    for (const name of m[1]!.split(",")) {
      const trimmed = name
        .trim()
        .replace(/\s+as\s+\w+/, "")
        .trim();
      if (trimmed) names.push(trimmed);
    }
  }
  return names;
};

/** Extract exported names from a file */
function extractExports(filePath: string): string[] {
  const content = fs.readFileSync(path.resolve(ROOT, filePath), "utf-8");
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

const srcFiles = collectFiles("src").filter(
  (f) =>
    !f.startsWith("src/test-utils/") &&
    !f.startsWith("src/ui/static/") &&
    !f.endsWith(".d.ts"),
);
const testUtilFiles = collectFiles("src/test-utils");
const testFiles = collectFiles("test");
const scriptFiles = collectFiles("scripts");
const allFiles = [...srcFiles, ...testFiles, ...testUtilFiles, ...scriptFiles];

// Known entry points that are used outside the import graph
const entryPoints = new Set([
  "src/index.ts", // deno task start
  "src/edge.ts", // esbuild entry for Bunny CDN
  "src/fp.ts", // import map root alias
  "src/routes/index.ts", // import map root alias
  "src/doc.ts", // deno doc generation
  "src/lib/jsx/jsx-dev-runtime.ts", // jsxImportSource compiler config
]);

// Docs files are used by deno doc via src/doc.ts - mark as known
const docsFiles = srcFiles.filter((f) => f.startsWith("src/docs/"));
for (const f of docsFiles) entryPoints.add(f);

type ImportInfo = { file: string; names: string[] };
const importedBySrc = new Map<string, ImportInfo[]>();
const importedByTest = new Map<string, ImportInfo[]>();

for (const file of allFiles) {
  const imports = extractImports(file);
  for (const { specifier, names } of imports) {
    const resolved = resolveImport(specifier, file);
    if (!resolved?.startsWith("src/")) continue;

    let target = resolved;
    const allSrcFiles = [...srcFiles, ...testUtilFiles];
    if (!allSrcFiles.includes(target)) {
      if (allSrcFiles.includes(`${target}.ts`)) target = `${target}.ts`;
      else if (allSrcFiles.includes(`${target}.tsx`)) target = `${target}.tsx`;
      else if (allSrcFiles.includes(`${target}/index.ts`)) {
        target = `${target}/index.ts`;
      }
    }

    const info: ImportInfo = { file, names };

    if (file.startsWith("test/") || file.startsWith("src/test-utils/")) {
      if (!importedByTest.has(target)) importedByTest.set(target, []);
      importedByTest.get(target)!.push(info);
    } else if (file.startsWith("src/") || file.startsWith("scripts/")) {
      if (!importedBySrc.has(target)) importedBySrc.set(target, []);
      importedBySrc.get(target)!.push(info);
    }
  }
}

// ---- Check 1: Files only imported from tests ----
console.log("═══════════════════════════════════════════════════════════════");
console.log("  FILES imported by test/ but NEVER by other src/ files");
console.log(
  "═══════════════════════════════════════════════════════════════\n",
);

let fileCount = 0;
for (const srcFile of srcFiles) {
  if (entryPoints.has(srcFile)) continue;
  if (srcFile.startsWith("src/ui/client/")) continue;

  const srcImporters = importedBySrc.get(srcFile) ?? [];
  const testImporters = importedByTest.get(srcFile) ?? [];

  if (srcImporters.length === 0 && testImporters.length > 0) {
    fileCount++;
    const testFileList = [...new Set(testImporters.map((i) => i.file))];
    console.log(`  ${srcFile}`);
    for (const tf of testFileList) {
      console.log(`    <- ${tf}`);
    }
    console.log();
  }
}

if (fileCount === 0) {
  console.log("  None found.\n");
} else {
  console.log(`  Total: ${fileCount} file(s)\n`);
}

// ---- Check 2: Individual exports only used in tests ----
console.log("═══════════════════════════════════════════════════════════════");
console.log("  EXPORTS used in test/ but NEVER in other src/ files");
console.log(
  "═══════════════════════════════════════════════════════════════\n",
);

let exportCount = 0;
for (const srcFile of srcFiles) {
  const srcImporters = importedBySrc.get(srcFile) ?? [];
  const testImporters = importedByTest.get(srcFile) ?? [];

  if (srcImporters.length === 0) continue;
  if (testImporters.length === 0) continue;

  const fileExports = extractExports(srcFile);
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

if (exportCount === 0) {
  console.log("  None found.\n");
} else {
  console.log(`  Total: ${exportCount} export(s)\n`);
}

// ---- Check 3: Files not imported by anything (dead code) ----
console.log("═══════════════════════════════════════════════════════════════");
console.log("  FILES not imported by anything (potential dead code)");
console.log(
  "═══════════════════════════════════════════════════════════════\n",
);

let deadCount = 0;
for (const srcFile of srcFiles) {
  if (entryPoints.has(srcFile)) continue;
  if (srcFile.startsWith("src/ui/client/")) continue;

  const srcImporters = importedBySrc.get(srcFile) ?? [];
  const testImporters = importedByTest.get(srcFile) ?? [];

  if (srcImporters.length === 0 && testImporters.length === 0) {
    deadCount++;
    console.log(`  ${srcFile}`);
  }
}

if (deadCount === 0) {
  console.log("  None found.\n");
} else {
  console.log(`\n  Total: ${deadCount} file(s)\n`);
}
