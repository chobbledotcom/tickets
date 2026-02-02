import { describe, expect, test } from "#test-compat";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(currentDir, "../../src");
const TEST_DIR = join(currentDir, "../../test");

/**
 * Patterns that indicate in-memory state storage at module level.
 * These should be stored in the database instead to survive restarts.
 */
const FORBIDDEN_PATTERNS = [
  {
    pattern: /^(?:export\s+)?(?:const|let)\s+\w+\s*=\s*new\s+Map\s*[<(]/m,
    description: "Module-level Map (use database instead)",
  },
  {
    pattern: /^(?:export\s+)?(?:const|let)\s+\w+\s*=\s*new\s+Set\s*[<(]/m,
    description: "Module-level Set (use database instead)",
  },
  {
    pattern: /^(?:export\s+)?(?:const|let)\s+\w+\s*:\s*Map\s*</m,
    description: "Module-level typed Map (use database instead)",
  },
  {
    pattern: /^(?:export\s+)?(?:const|let)\s+\w+\s*:\s*Set\s*</m,
    description: "Module-level typed Set (use database instead)",
  },
];

/**
 * Test utility files - excluded from all code quality checks
 */
const TEST_UTILITY_FILES = [
  "test-utils/index.ts",
  "test-utils/stripe-mock.ts",
  "test-utils/test-compat.ts",
];

/**
 * Files that are allowed to have in-memory state (e.g., test utilities, caches)
 */
const ALLOWED_FILES_STATE = [
  ...TEST_UTILITY_FILES,
  // Session cache with 10s TTL - legitimate performance optimization
  "lib/db/sessions.ts",
];

/**
 * Pattern to detect function/variable aliasing at module level.
 * Forces use of `import { x as y }` instead of post-import aliasing.
 * Example violation: const myFunc = someImportedFunc;
 * Only matches identifiers (starts with letter/underscore), not literals.
 */
const ALIASING_PATTERN =
  /^(?:export\s+)?const\s+(\w+)\s*=\s*([a-zA-Z_]\w*)\s*;?\s*(?:\/\/.*)?$/;

/**
 * Pattern to detect .then() usage - prefer async/await
 */
const THEN_PATTERN = /\.then\s*\(/g;

const getAllTsFiles = async (dir: string): Promise<string[]> => {
  const files: string[] = [];

  for await (const entry of Deno.readDir(dir)) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory) {
      files.push(...(await getAllTsFiles(fullPath)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }

  return files;
};

const getRelativePath = (fullPath: string): string =>
  fullPath.replace(`${SRC_DIR}/`, "");

describe("code quality", () => {
  describe("no in-memory state", () => {
    test("source files should not use module-level Map or Set for state", async () => {
      const files = await getAllTsFiles(SRC_DIR);
      const violations: string[] = [];

      for (const file of files) {
        const relativePath = getRelativePath(file);

        if (ALLOWED_FILES_STATE.includes(relativePath)) {
          continue;
        }

        const content = await Deno.readTextFile(file);

        for (const { pattern, description } of FORBIDDEN_PATTERNS) {
          if (pattern.test(content)) {
            violations.push(`${relativePath}: ${description}`);
          }
        }
      }

      expect(violations).toEqual([]);
    });
  });

  describe("no aliasing", () => {
    test("should not alias functions or variables at module level", async () => {
      const files = await getAllTsFiles(SRC_DIR);
      const violations: string[] = [];

      for (const file of files) {
        const relativePath = getRelativePath(file);
        if (TEST_UTILITY_FILES.includes(relativePath)) continue;
        const content = await Deno.readTextFile(file);
        const lines = content.split("\n");

        let lineNum = 0;
        for (const line of lines) {
          lineNum++;
          const match = line.match(ALIASING_PATTERN);

          if (match) {
            const [, varName, value] = match;
            violations.push(
              `${relativePath}:${lineNum}: const ${varName} = ${value} (use import { ${value} as ${varName} } instead)`,
            );
          }
        }
      }

      expect(violations).toEqual([]);
    });
  });

  describe("no module-level let", () => {
    test("should use const with once()/lazyRef() instead of let", async () => {
      const files = await getAllTsFiles(SRC_DIR);
      const violations: string[] = [];

      for (const file of files) {
        const relativePath = getRelativePath(file);
        if (TEST_UTILITY_FILES.includes(relativePath)) continue;
        const content = await Deno.readTextFile(file);
        const lines = content.split("\n");

        let lineNum = 0;
        for (const line of lines) {
          lineNum++;

          // Only check module-level let (not indented)
          if (line.match(/^(export\s+)?let\s+/)) {
            violations.push(
              `${relativePath}:${lineNum}: ${line.slice(0, 50)}... (use const with once()/lazyRef())`,
            );
          }
        }
      }

      expect(violations).toEqual([]);
    });
  });

  describe("no .then() usage", () => {
    test("should use async/await instead of .then()", async () => {
      const files = await getAllTsFiles(SRC_DIR);
      const violations: string[] = [];

      for (const file of files) {
        const relativePath = getRelativePath(file);
        const content = await Deno.readTextFile(file);
        const lines = content.split("\n");

        let lineNum = 0;
        for (const line of lines) {
          lineNum++;

          if (THEN_PATTERN.test(line)) {
            THEN_PATTERN.lastIndex = 0;
            violations.push(
              `${relativePath}:${lineNum}: ${line.trim().slice(0, 50)}... (use async/await instead)`,
            );
          }
        }
      }

      expect(violations).toEqual([]);
    });
  });

  describe("no test-only exports", () => {
    /**
     * Detects exports that exist solely to be tested, violating the principle of
     * testing outcomes rather than implementation. These typically include:
     * - Reset/clear functions only used in test cleanup (e.g., resetFooClient)
     * - Internal helper functions exported just to unit test them
     * - Config getters that are never actually called in production
     *
     * Excluded from checking:
     * - Test utility modules (test-utils/*) - explicitly for testing
     * - Library modules (fp/*) - reusable utilities, may not all be used yet
     * - JSX runtime modules (lib/jsx/*) - used implicitly by JSX compiler
     * - Index files that only re-export (lib/db/index.ts) - aggregation modules
     */

    /** Files explicitly for testing */
    const TEST_UTILITY_PATHS = TEST_UTILITY_FILES;

    /** Library/infrastructure modules - okay to have unused exports */
    const LIBRARY_PATHS = [
      "fp/index.ts", // FP utility library
      "lib/jsx/jsx-runtime.ts", // JSX compiler runtime
      "lib/jsx/jsx-dev-runtime.ts", // JSX dev runtime
      "config/asset-paths.ts", // Build-time config consumed by .tsx templates
    ];

    /** Index modules that only re-export from sub-modules */
    const AGGREGATION_MODULES = [
      "lib/db/index.ts",
      "lib/rest/index.ts",
      "templates/index.ts",
    ];

    /**
     * Test hooks - functions that are intentionally exported for test setup/cleanup.
     * These are necessary for testing but should not be used in production code.
     * Format: "file:exportName"
     */
    const ALLOWED_TEST_HOOKS: string[] = [
      // Database injection for test isolation
      "lib/db/client.ts:setDb",
      // Reset cached encryption key between tests
      "lib/crypto.ts:clearEncryptionKeyCache",
      // Reset cached Stripe client between tests
      "lib/stripe.ts:resetStripeClient",
      // Reset cached setup complete status between tests
      "lib/db/settings.ts:clearSetupCompleteCache",
      // Reset cached sessions between tests
      "lib/db/sessions.ts:resetSessionCache",
      // DB version constant used in production but test pattern doesn't detect constant comparison
      "lib/db/migrations/index.ts:LATEST_UPDATE",
      // Client-side Stripe publishable key (for future payment form templates)
      "lib/config.ts:getStripePublishableKey",
      // Test helper for creating signed webhook payloads
      "lib/stripe.ts:constructTestWebhookEvent",
      // Reset cached Square client between tests
      "lib/square.ts:resetSquareClient",
      // Test helper for creating signed Square webhook payloads
      "lib/square.ts:constructTestWebhookEvent",
      // Convenience wrapper for idempotency checks (production uses isSessionProcessed directly)
      "lib/db/processed-payments.ts:getProcessedAttendeeId",
      // Raw attendee fetch for testing encrypted data (production uses batched getEventWithAttendeesRaw)
      "lib/db/attendees.ts:getAttendeesRaw",
      // Single attendee fetch for tests (production uses batched getEventWithAttendeeRaw)
      "lib/db/attendees.ts:getAttendee",
      // Event activity log fetch for tests (production uses batched getEventWithActivityLog)
      "lib/db/activityLog.ts:getEventActivityLog",
    ];

    /**
     * Patterns to extract exported symbols from source files.
     * Only captures direct exports, not re-exports.
     */
    const EXPORT_PATTERNS = [
      // export const/let name = ...
      /^export\s+(?:const|let)\s+(\w+)/gm,
      // export function name(...) or export async function name(...)
      /^export\s+(?:async\s+)?function\s+(\w+)/gm,
      // export class name
      /^export\s+class\s+(\w+)/gm,
    ];

    /** Pattern to detect re-export statements (export { x } from "y") */
    const RE_EXPORT_PATTERN = /^export\s+\{[^}]+\}\s+from\s+['"]/m;

    const extractExports = (content: string): string[] => {
      const exports: string[] = [];

      for (const pattern of EXPORT_PATTERNS) {
        pattern.lastIndex = 0;
        for (const match of content.matchAll(pattern)) {
          const captured = match[1];
          if (captured) {
            exports.push(captured.trim());
          }
        }
      }

      return exports;
    };

    /**
     * Check if a symbol is used within the same file (not just defined).
     * Looks for patterns like `symbolName(` (function calls) or `symbolName.` (property access).
     */
    const isUsedInSameFile = (symbolName: string, content: string): boolean => {
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
        // Matches: name(, name., name, (in objects), name: (with type)
        const usagePattern = new RegExp(`\\b${symbolName}\\s*[.(,:]`);
        if (usagePattern.test(line)) {
          usageCount++;
        }
      }

      return usageCount > 0;
    };

    /** Get all .tsx files in a directory recursively */
    const getAllTsxFiles = async (dir: string): Promise<string[]> => {
      const files: string[] = [];
      for await (const entry of Deno.readDir(dir)) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory) {
          files.push(...(await getAllTsxFiles(fullPath)));
        } else if (entry.name.endsWith(".tsx")) {
          files.push(fullPath);
        }
      }
      return files;
    };

    const isUsedInProductionCode = async (
      symbolName: string,
      sourceFile: string,
      srcFiles: string[],
    ): Promise<boolean> => {
      // Check if it's used within the same file
      const sourceContent = await Deno.readTextFile(sourceFile);
      if (isUsedInSameFile(symbolName, sourceContent)) {
        return true;
      }

      // Pattern to find imports of this symbol
      const importPattern = new RegExp(
        `import\\s*\\{[^}]*\\b${symbolName}\\b[^}]*\\}`,
      );

      // Check .ts files
      for (const file of srcFiles) {
        if (file === sourceFile) continue;

        const relativePath = getRelativePath(file);
        // Skip test utilities - imports there don't count as production usage
        if (TEST_UTILITY_PATHS.includes(relativePath)) continue;

        const content = await Deno.readTextFile(file);
        if (importPattern.test(content)) {
          return true;
        }
      }

      // Also check .tsx files as importers
      const tsxFiles = await getAllTsxFiles(SRC_DIR);
      for (const file of tsxFiles) {
        const content = await Deno.readTextFile(file);
        if (importPattern.test(content)) {
          return true;
        }
      }

      return false;
    };

    /** Check if a symbol is imported in any test file */
    const isUsedInTests = async (symbolName: string): Promise<boolean> => {
      const testFiles = await getAllTsFiles(TEST_DIR);
      const importPattern = new RegExp(
        `import\\s*\\{[^}]*\\b${symbolName}\\b[^}]*\\}`,
      );

      for (const testFile of testFiles) {
        const testContent = await Deno.readTextFile(testFile);
        if (importPattern.test(testContent)) {
          return true;
        }
      }
      return false;
    };

    /** Check if a file should be skipped (test utils, libraries, aggregation modules) */
    const shouldSkipFile = (relativePath: string): boolean =>
      TEST_UTILITY_PATHS.includes(relativePath) ||
      LIBRARY_PATHS.includes(relativePath) ||
      AGGREGATION_MODULES.includes(relativePath);

    /** Check if a file is primarily a re-export module */
    const isPrimarilyReExportModule = (content: string): boolean => {
      if (!RE_EXPORT_PATTERN.test(content)) return false;

      const lines = content.split("\n");
      const exportLines = lines.filter((l) => l.startsWith("export"));
      const reExportLines = lines.filter((l) =>
        /^export\s+\{[^}]+\}\s+from\s+['"]/.test(l),
      );
      return reExportLines.length > exportLines.length / 2;
    };

    /** Find test-only violations for a single file */
    const findFileViolations = async (
      file: string,
      srcFiles: string[],
    ): Promise<string[]> => {
      const relativePath = getRelativePath(file);
      const violations: string[] = [];

      const content = await Deno.readTextFile(file);
      if (isPrimarilyReExportModule(content)) return violations;

      const exports = extractExports(content);

      for (const exportName of exports) {
        const hookKey = `${relativePath}:${exportName}`;
        if (ALLOWED_TEST_HOOKS.includes(hookKey)) continue;

        const usedInProduction = await isUsedInProductionCode(
          exportName,
          file,
          srcFiles,
        );

        if (!usedInProduction && (await isUsedInTests(exportName))) {
          violations.push(
            `${relativePath}: "${exportName}" is exported but only used in tests`,
          );
        }
      }

      return violations;
    };

    test("exports from src/ should be used in production code, not just tests", async () => {
      const srcFiles = await getAllTsFiles(SRC_DIR);
      const violations: string[] = [];

      for (const file of srcFiles) {
        const relativePath = getRelativePath(file);
        if (shouldSkipFile(relativePath)) continue;

        const fileViolations = await findFileViolations(file, srcFiles);
        violations.push(...fileViolations);
      }

      expect(violations).toEqual([]);
    });
  });
});
