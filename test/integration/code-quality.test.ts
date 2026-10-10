import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  AGGREGATION_MODULES,
  ALLOWED_DUPLICATE_TYPE_SHAPES,
  ALLOWED_TEST_HOOKS,
  LIBRARY_PATHS,
} from "#test/integration/code-quality/allowlists.ts";
import {
  detectAliasing,
  detectModuleLevelLet,
  detectThenUsage,
  extractCallSites,
  extractTypeShapes,
  findDuplicateTypeShapes,
  findInMemoryStateViolations,
  findRawDbViolation,
  findRedundantArg,
  findTestOnlyExportViolations,
  type NamedTypeShape,
  type Site,
} from "#test/scripts/code-quality/detectors.ts";
import { detectRelativeImport } from "#test/scripts/code-quality/relative-import.ts";
import {
  ensureLoaded,
  getRelativePath,
  type ScanContext,
  scanSourceFiles,
  scanSourceLines,
} from "#test/scripts/code-quality/scan-context.ts";

/**
 * Integration guard for the code-quality rules: it scans the real `src/`+`test/`
 * tree and asserts there are zero violations. The detection logic lives in
 * `test/scripts/code-quality/detectors.ts` and is proven with crafted fixtures
 * in `test/scripts/code-quality/detectors.test.ts`; the file-discovery and scan
 * plumbing lives in `test/scripts/code-quality/scan-context.ts`. This file
 * holds the live "is the codebase clean?" assertions and the policy
 * allow-lists, since the allow-lists describe this codebase rather than the
 * rules.
 */

/**
 * src/ files allowed to hold module-level Map/Set state (the in-memory-state
 * rule is src-only; test code may use Maps/Sets freely).
 */
const ALLOWED_FILES_STATE = [
  // Process-local registry of cache-invalidation callbacks, wired at module
  // load (like the providers array beside it); not persistent app state.
  "shared/cache-registry.ts",
  // Session cache with 10s TTL - legitimate performance optimization
  "shared/db/sessions.ts",
  // Settings test overrides Map for injecting test values into the snapshot
  "shared/db/settings.ts",
  // Test override flags (lazyRef state for test isolation)
  "shared/test-overrides.ts",
  // Short-TTL warm-isolate stash for re-filling forms after a redirect;
  // one-shot, size/count-capped, with a cookie-flash fallback when cold.
  "shared/form-stash.ts",
  // Loaded-catalog registry, in-flight loader promises, and compiled ICU
  // formats. These are warm-isolate caches; route visibility is request-scoped.
  "shared/i18n.ts",
];

// Direct getDb().execute / .batch calls bypass the single client choke
// point that drives automatic, table-scoped cache invalidation, so a write
// through them can silently leave a cache stale. All callers must use
// execute()/queryOne()/queryAll()/executeBatch() instead. Only the client
// itself and the migrator (which runs DDL/backfill before caches matter)
// may touch the raw connection.
const ALLOWED_RAW_DB = [
  "shared/db/client.ts",
  // The migrator runs DDL / schema setup / backfill before the app serves
  // requests, so cache invalidation does not apply to it.
  "shared/db/migrations.ts",
  "shared/db/migrations/",
];

describe("code quality", () => {
  describe("no in-memory state", () => {
    test("source files should not use module-level Map or Set for state", async () => {
      const { srcFiles, srcContents } = await ensureLoaded();
      const violations: string[] = [];

      for (const file of srcFiles) {
        const relativePath = getRelativePath(file);
        violations.push(
          ...findInMemoryStateViolations(
            relativePath,
            srcContents.get(file)!,
            ALLOWED_FILES_STATE,
          ),
        );
      }

      expect(violations).toEqual([]);
    });
  });

  describe("db writes go through the client", () => {
    test("no source file calls getDb().execute/.batch directly", async () => {
      const { srcFiles, srcContents } = await ensureLoaded();
      const violations: string[] = [];

      for (const file of srcFiles) {
        const violation = findRawDbViolation(
          getRelativePath(file),
          srcContents.get(file)!,
          ALLOWED_RAW_DB,
        );
        if (violation) violations.push(violation);
      }

      expect(violations).toEqual([]);
    });
  });

  describe("no aliasing", () => {
    test("should not alias functions or variables at module level", async () => {
      const violations = await scanSourceLines(detectAliasing);
      expect(violations).toEqual([]);
    });
  });

  describe("no module-level let", () => {
    test("should use const with once()/lazyRef() instead of let", async () => {
      const violations = await scanSourceLines(detectModuleLevelLet);
      expect(violations).toEqual([]);
    });
  });

  describe("no .then() usage", () => {
    test("should use async/await instead of .then()", async () => {
      const violations = await scanSourceLines(detectThenUsage);
      expect(violations).toEqual([]);
    });
  });

  describe("no ../ relative imports", () => {
    /**
     * Parent-walking relative imports tie a file to its location in the tree.
     * The `#` aliases in deno.json map every top-level dir (src, test, scripts,
     * cli, e2e-payments) to a stable prefix, so a file can name what it imports
     * without caring where it sits — and a moved file keeps working. The rule
     * scans tsx templates and the hand-written `.js` browser source too, since
     * UI templates were the worst offender for `../`-walking to sibling files
     * and `src/ui/client/scanner.js` is the only hand-written non-ts entry.
     *
     * One token-aware whole-file walk covers every form the rule has to
     * catch — side-effect, dynamic, static, same-line, split-across-lines,
     * and `import(/* note *\/ "../x")` with comments in the gap. Walking
     * past comments and string literals also keeps a test fixture that
     * quotes `'import "../x"'` as data from falsely flagging.
     */
    test("imports should use a # alias, not ../", async () => {
      const violations = await scanSourceFiles(detectRelativeImport);
      expect(violations).toEqual([]);
    });
  });

  describe("no test-only exports", () => {
    /**
     * Detects exports that exist solely to be tested, violating the principle of
     * testing outcomes rather than implementation. Excluded from checking:
     * library modules (fp/*), JSX runtimes, and index files that only re-export.
     * (Test utilities live under test/, so this src-only rule never sees them.)
     */
    const shouldSkipFile = (relativePath: string): boolean =>
      LIBRARY_PATHS.includes(relativePath) ||
      AGGREGATION_MODULES.includes(relativePath);

    test("exports from src/ should be used in production code, not just tests", async () => {
      const scan = await ensureLoaded();
      const violations: string[] = [];

      for (const file of scan.srcFiles) {
        const relativePath = getRelativePath(file);
        if (shouldSkipFile(relativePath)) continue;

        violations.push(
          ...findTestOnlyExportViolations(
            file,
            relativePath,
            scan.srcContents,
            scan.srcTsxContents,
            scan.testContents,
            ALLOWED_TEST_HOOKS,
            [scan.scriptsContents, scan.cliContents, scan.e2eContents],
          ),
        );
      }

      expect(violations).toEqual([]);
    });
  });

  describe("no redundant constant arguments", () => {
    /**
     * Pool call sites across all production source (src + tsx) by callee name.
     * This rule is about production API design — pooling test call sites would
     * flag production functions for constants only tests happen to pass, so it
     * stays src-scoped (like in-memory-state and test-only exports).
     */
    const collectCallSites = ({
      srcFiles,
      srcContents,
      srcTsxFiles,
      srcTsxContents,
    }: ScanContext): Map<string, Site[]> => {
      const byName = new Map<string, Site[]>();
      const record = (file: string, content: string): void => {
        const relativePath = getRelativePath(file);
        for (const call of extractCallSites(content)) {
          const sites = byName.get(call.name) ?? [];
          sites.push({ args: call.args, file: relativePath, line: call.line });
          byName.set(call.name, sites);
        }
      };
      for (const file of srcFiles) record(file, srcContents.get(file)!);
      for (const file of srcTsxFiles) record(file, srcTsxContents.get(file)!);
      return byName;
    };

    test("functions should not always receive the same constant argument", async () => {
      const scan = await ensureLoaded();
      const violations: string[] = [];
      for (const [name, sites] of collectCallSites(scan)) {
        const violation = findRedundantArg(name, sites);
        if (violation) violations.push(violation);
      }
      violations.sort();
      expect(violations).toEqual([]);
    });
  });

  describe("no duplicate type shapes", () => {
    /**
     * Collect every object-shaped `type`/`interface` across production source
     * (src + tsx), keyed by file. Prefer generic, reusable objects: two
     * differently-named types with identical members should be one shared type.
     * Coincidental cross-domain matches live in ALLOWED_DUPLICATE_TYPE_SHAPES.
     */
    const collectTypeShapes = ({
      srcFiles,
      srcContents,
      srcTsxFiles,
      srcTsxContents,
    }: ScanContext): NamedTypeShape[] => {
      const defs: NamedTypeShape[] = [];
      const record = (file: string, content: string): void => {
        const relativePath = getRelativePath(file);
        for (const shape of extractTypeShapes(content)) {
          defs.push({ ...shape, file: relativePath });
        }
      };
      for (const file of srcFiles) record(file, srcContents.get(file)!);
      for (const file of srcTsxFiles) record(file, srcTsxContents.get(file)!);
      return defs;
    };

    test("no two types should declare the same object shape", async () => {
      const scan = await ensureLoaded();
      const allowed = ALLOWED_DUPLICATE_TYPE_SHAPES.map((a) => a.signature);
      const violations = findDuplicateTypeShapes(
        collectTypeShapes(scan),
        allowed,
      );
      expect(violations).toEqual([]);
    });
  });
});
