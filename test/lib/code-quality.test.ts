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
const ALLOWED_FILES = ["test-utils/index.ts", "test-utils/stripe-mock.ts"];

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

        if (ALLOWED_FILES.includes(relativePath)) {
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
});
