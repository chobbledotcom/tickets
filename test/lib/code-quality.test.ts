import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const SRC_DIR = join(import.meta.dir, "../../src");

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
 * Files that are allowed to have in-memory state (e.g., test utilities)
 */
const ALLOWED_FILES_STATE = [
  "test-utils/index.ts",
  "test-utils/stripe-mock.ts",
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
 * Allowed let patterns:
 * - `let varName = null;` for lazy loading
 * - `let varName: Type | null = null;` for typed lazy loading/memoization
 */
const ALLOWED_LET_PATTERNS = [
  /^let\s+\w+\s*=\s*null\s*;?\s*(?:\/\/.*)?$/, // let x = null;
  /^let\s+\w+\s*:\s*[\w<>[\]|, ]+\s*=\s*null\s*;?\s*(?:\/\/.*)?$/, // let x: Type = null;
];

const isAllowedLetPattern = (line: string): boolean =>
  ALLOWED_LET_PATTERNS.some((pattern) => pattern.test(line));

/**
 * Files allowed to have any let declarations (initialization flags)
 */
const ALLOWED_FILES_LET = ["edge/bunny-script.ts"];

/**
 * Specific allowed let declarations in format "file:lineContent"
 * For legitimate patterns like timing-safe comparison accumulators
 */
const ALLOWED_LET_LINES = [
  "lib/crypto.ts:let result = 0;", // timing-safe comparison accumulator
  'test-utils/index.ts:let result = "";', // string builder in test utility
];

/**
 * Pattern to detect .then() usage - prefer async/await
 */
const THEN_PATTERN = /\.then\s*\(/g;

const getAllTsFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
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

        const content = await Bun.file(file).text();

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
        const content = await Bun.file(file).text();
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

  describe("no let declarations", () => {
    test("should only use let for lazy loading (let x = null)", async () => {
      const files = await getAllTsFiles(SRC_DIR);
      const violations: string[] = [];

      for (const file of files) {
        const relativePath = getRelativePath(file);

        if (ALLOWED_FILES_LET.includes(relativePath)) {
          continue;
        }

        const content = await Bun.file(file).text();
        const lines = content.split("\n");

        let lineNum = 0;
        for (const rawLine of lines) {
          lineNum++;
          const line = rawLine.trim();

          if (line.startsWith("let ") || line.startsWith("export let ")) {
            const normalizedLine = line.replace(/^export\s+/, "");

            if (isAllowedLetPattern(normalizedLine)) {
              continue;
            }

            const allowKey = `${relativePath}:${normalizedLine}`;
            if (ALLOWED_LET_LINES.includes(allowKey)) {
              continue;
            }

            violations.push(
              `${relativePath}:${lineNum}: ${line.slice(0, 50)}... (use const with immutable patterns)`,
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
        const content = await Bun.file(file).text();
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
});
