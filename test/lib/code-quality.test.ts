import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";

const currentDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(currentDir, "../..");
const SRC_DIR = join(currentDir, "../../src");
const TEST_DIR = join(currentDir, "../../test");

/**
 * Patterns that indicate in-memory state storage at module level.
 * These should be stored in the database instead to survive restarts.
 */
const FORBIDDEN_PATTERNS = [
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
  // Compiled ICU MessageFormat cache keyed by locale + message key;
  // immutable derived data (parsing is non-trivial), not mutable app state.
  "shared/i18n.ts",
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

const getAllFilesWithExt = async (
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

const getAllTsFiles = (dir: string): Promise<string[]> =>
  getAllFilesWithExt(dir, ".ts");

const getRelativePath = (fullPath: string): string =>
  fullPath.replace(`${SRC_DIR}/`, "");

/**
 * Path relative to the repo root, e.g. "src/foo.ts" or "test/foo.ts". Used by
 * the rules that scan both src and test files (aliasing, module-level let,
 * .then(), redundant constant args) so their violation paths are unambiguous.
 */
const repoRelative = (fullPath: string): string =>
  fullPath.replace(`${REPO_ROOT}/`, "");

/** Read all files once and cache contents in a Map keyed by path */
const readAllFiles = async (files: string[]): Promise<Map<string, string>> => {
  const entries = await Promise.all(
    files.map(async (f) => [f, await Deno.readTextFile(f)] as const),
  );
  return new Map(entries);
};

/* -------------------------------------------------------------------------- *
 * Lightweight call-site scanner (used by the "redundant constant argument"   *
 * check). It is intentionally a small hand-written lexer rather than a full  *
 * AST parser, matching the regex-driven style of the rest of this file. It   *
 * skips comments and string/template literals so callee names and argument   *
 * text are never matched inside them.                                        *
 * -------------------------------------------------------------------------- */

/** A single call expression discovered in a source file. */
type CallSite = { name: string; args: string[]; line: number };

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

const isIdentChar = (c: string | undefined): boolean => !!c && /[\w$]/.test(c);
const isIdentStart = (c: string | undefined): boolean =>
  !!c && /[A-Za-z_$]/.test(c);
const isWhitespace = (c: string | undefined): boolean => !!c && /\s/.test(c);

/**
 * Skip a string or template literal starting at the opening quote `start`.
 * Returns the index immediately after the closing quote. Template `${...}`
 * substitutions are skipped wholesale (including nested strings) so a `)` or
 * `,` inside them never leaks into argument parsing.
 */
const skipString = (content: string, start: number): number => {
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
const skipComment = (content: string, i: number): number => {
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
const parseArgList = (
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
  while (j < content.length && isIdentChar(content[j])) j++;
  const word = content.slice(i, j);
  let k = j;
  while (k < content.length && isWhitespace(content[k])) k++;
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
const extractCallSites = (content: string): CallSite[] => {
  const calls: RawCall[] = [];
  let prevWord = "";
  let i = 0;
  while (i < content.length) {
    const c = content[i];
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

describe("code quality", () => {
  /** Cached file lists and contents, populated once on first use */
  let srcFiles: string[];
  let srcContents: Map<string, string>;
  let testFiles: string[];
  let testContents: Map<string, string>;
  let tsxFiles: string[];
  let tsxContents: Map<string, string>;

  const ensureLoaded = async (): Promise<void> => {
    if (srcContents) return;
    const [sf, tf, txf] = await Promise.all([
      getAllTsFiles(SRC_DIR),
      getAllTsFiles(TEST_DIR),
      getAllFilesWithExt(SRC_DIR, ".tsx"),
    ]);
    srcFiles = sf;
    testFiles = tf;
    tsxFiles = txf;
    const [sc, tc, txc] = await Promise.all([
      readAllFiles(srcFiles),
      readAllFiles(testFiles),
      readAllFiles(tsxFiles),
    ]);
    srcContents = sc;
    testContents = tc;
    tsxContents = txc;
  };

  describe("no in-memory state", () => {
    test("source files should not use module-level Map or Set for state", async () => {
      await ensureLoaded();
      const violations: string[] = [];

      for (const file of srcFiles) {
        const relativePath = getRelativePath(file);

        if (ALLOWED_FILES_STATE.includes(relativePath)) {
          continue;
        }

        const content = srcContents.get(file)!;

        for (const { pattern, description } of FORBIDDEN_PATTERNS) {
          if (pattern.test(content)) {
            violations.push(`${relativePath}: ${description}`);
          }
        }
      }

      expect(violations).toEqual([]);
    });
  });

  describe("db writes go through the client", () => {
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
    const RAW_DB_PATTERN = /getDb\(\)\.(?:execute|batch)\s*\(/;

    test("no source file calls getDb().execute/.batch directly", async () => {
      await ensureLoaded();
      const violations: string[] = [];

      for (const file of srcFiles) {
        const relativePath = getRelativePath(file);
        if (
          ALLOWED_RAW_DB.some((allowed) => relativePath.startsWith(allowed))
        ) {
          continue;
        }
        if (RAW_DB_PATTERN.test(srcContents.get(file)!)) {
          violations.push(
            `${relativePath}: use execute()/queryOne()/queryAll()/executeBatch() from #shared/db/client.ts instead of getDb().execute/.batch`,
          );
        }
      }

      expect(violations).toEqual([]);
    });
  });

  /**
   * Scan src and test files line by line, collecting violations via a callback.
   * Test code is held to the same line-level standards as production code.
   * Returns the combined violation list.
   */
  const scanSourceLines = async (
    check: (ctx: {
      relativePath: string;
      line: string;
      lineNum: number;
    }) => string | null,
  ): Promise<string[]> => {
    await ensureLoaded();
    const violations: string[] = [];
    const scan = (files: string[], contents: Map<string, string>): void => {
      for (const file of files) {
        const relativePath = repoRelative(file);
        // This file defines the patterns it checks for (in comments, regexes
        // and test names), so it would flag itself. It has no real line-level
        // violations of its own, so skip it from the line scans.
        if (relativePath === "test/lib/code-quality.test.ts") continue;
        const lines = contents.get(file)!.split("\n");
        let lineNum = 0;
        for (const line of lines) {
          lineNum++;
          const v = check({ line, lineNum, relativePath });
          if (v) violations.push(v);
        }
      }
    };
    scan(srcFiles, srcContents);
    scan(testFiles, testContents);
    return violations;
  };

  describe("no aliasing", () => {
    test("should not alias functions or variables at module level", async () => {
      const violations = await scanSourceLines(
        ({ relativePath, line, lineNum }) => {
          const match = line.match(ALIASING_PATTERN);
          if (!match) return null;
          const [, varName, value] = match;
          return `${relativePath}:${lineNum}: const ${varName} = ${value} (use import { ${value} as ${varName} } instead)`;
        },
      );

      expect(violations).toEqual([]);
    });
  });

  describe("no module-level let", () => {
    test("should use const with once()/lazyRef() instead of let", async () => {
      const violations = await scanSourceLines(
        ({ relativePath, line, lineNum }) => {
          if (!line.match(/^(export\s+)?let\s+/)) return null;
          return `${relativePath}:${lineNum}: ${line.slice(
            0,
            50,
          )}... (use const with once()/lazyRef())`;
        },
      );

      expect(violations).toEqual([]);
    });
  });

  describe("no .then() usage", () => {
    test("should use async/await instead of .then()", async () => {
      const violations = await scanSourceLines(
        ({ relativePath, line, lineNum }) => {
          THEN_PATTERN.lastIndex = 0;
          if (!THEN_PATTERN.test(line)) return null;
          THEN_PATTERN.lastIndex = 0;
          return `${relativePath}:${lineNum}: ${line
            .trim()
            .slice(0, 50)}... (use async/await instead)`;
        },
      );

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
     * - Library modules (fp/*) - reusable utilities, may not all be used yet
     * - JSX runtime modules (shared/jsx/*) - used implicitly by JSX compiler
     * - Index files that only re-export (shared/db/index.ts) - aggregation modules
     *
     * (Test utilities live under test/, so this src-only rule never sees them.)
     */

    /** Library/infrastructure modules - okay to have unused exports */
    const LIBRARY_PATHS = [
      "fp.ts", // FP utility library
      "shared/jsx/jsx-runtime.ts", // JSX compiler runtime
      "shared/jsx/jsx-dev-runtime.ts", // JSX dev runtime
      "shared/asset-paths.ts", // Build-time config consumed by .tsx templates
    ];

    /** Index modules that only re-export from sub-modules */
    const AGGREGATION_MODULES = [
      "shared/db/index.ts",
      "shared/rest/index.ts",
      "templates/index.ts",
    ];

    /**
     * Test hooks - functions that are intentionally exported for test setup/cleanup.
     * These are necessary for testing but should not be used in production code.
     * Format: "file:exportName"
     */
    const ALLOWED_TEST_HOOKS: string[] = [
      // Database injection for test isolation
      "shared/db/client.ts:setDb",
      // Set encryption key directly to avoid env var races between parallel tests
      "shared/crypto/encryption.ts:setEncryptionKeyForTest",
      // Set fast PBKDF2 directly to avoid env var races between parallel tests
      "shared/crypto/hashing.ts:setFastPbkdf2ForTest",
      // Set RSA key size directly to avoid env var races between parallel tests
      "shared/crypto/keys.ts:setRsaKeySizeForTest",
      // Reset cached Stripe client between tests
      "shared/stripe.ts:resetStripeClient",
      // TTL constant used by page-cache tests to verify caching behaviour
      "shared/db/settings.ts:SETTINGS_CACHE_TTL_MS",
      // Dev/test-only switch for the settings read audit (no-op in production)
      "shared/db/settings-audit.ts:setSettingsAuditEnabled",
      // (settings.ts functions now accessed via settings namespace, not individual exports)
      // Reset cached sessions between tests
      "shared/db/sessions.ts:resetSessionCache",
      // Reset cached I18N_REPLACEMENTS replacer + compiled formats between tests
      "shared/i18n.ts:resetI18nForTest",
      // DB version/hash constants used in production but test pattern doesn't detect constant comparison
      "shared/db/migrations.ts:LATEST_UPDATE",
      "shared/db/migrations.ts:SCHEMA_HASH",
      // Migration lock TTL used in production (same-file) but test pattern doesn't detect same-file usage
      "shared/db/migrations.ts:MIGRATION_LOCK_TTL_MS",
      // Backup freshness window used in production (same-file) but test pattern doesn't detect same-file usage
      "shared/db/backup.ts:BACKUP_FRESHNESS_WINDOW_MS",
      // Attendees page size used in production (same-file) but test pattern doesn't detect same-file usage
      "shared/db/attendees/queries.ts:ATTENDEES_PAGE_SIZE",
      // Payments-retention floor guard used in production (same-file: validates
      // PRUNE_PAYMENTS_RETENTION_DAYS at import) but test pattern doesn't detect same-file usage
      "shared/limits.ts:assertPaymentsRetentionSafe",
      // Test helper for creating signed webhook payloads
      "shared/stripe.ts:constructTestWebhookEvent",
      // Reset cached Square client between tests
      "shared/square.ts:resetSquareClient",
      // Test helper for creating signed Square webhook payloads
      "shared/square.ts:constructTestWebhookEvent",
      // Convenience wrapper for idempotency checks (production uses isSessionProcessed directly)
      "shared/db/processed-payments.ts:getProcessedAttendeeId",
      // Raw attendee fetch for testing encrypted data (production uses batched getListingWithAttendeesRaw)
      "shared/db/attendees/queries.ts:getAttendeesRaw",
      // Single attendee fetch for tests (production uses batched getListingWithAttendeeRaw)
      "shared/db/attendees/queries.ts:getAttendee",
      // Listing activity log fetch for tests (production uses batched getListingWithActivityLog)
      "shared/db/activityLog.ts:getListingActivityLog",
      // Token format check used by CSRF tests (production verifies via verifySignedCsrfToken)
      "shared/csrf.ts:isSignedCsrfToken",
      // Response cookie helper used by auth tests (production sets cookies directly)
      "features/utils.ts:withCookie",
      // Reset cache registry between tests
      "shared/cache-registry.ts:resetCacheRegistry",
      // Request-cache invalidators kept for test cleanup only; in production
      // writes auto-invalidate through cachedTable's wrapped table, so these
      // have no production caller (groups/holidays have no raw-SQL writers).
      "shared/db/groups.ts:invalidateGroupsCache",
      "shared/db/holidays.ts:invalidateHolidaysCache",
      "shared/db/logistics-agents.ts:invalidateLogisticsAgentsCache",
      // Reset cached effective domain between tests
      "shared/config.ts:resetEffectiveDomain",
      "shared/config.ts:setEffectiveDomainForTest",
      // Reset cached demo mode between tests
      "shared/demo.ts:resetDemoMode",
      "shared/demo.ts:setDemoModeForTest",
      // Reset cached Liquid engine between tests (currency changes need fresh filters)
      "shared/email-renderer.ts:resetEngine",
      // Skip login delay in tests without env var races
      "shared/test-overrides.ts:setSkipLoginDelayForTest",
      // Reset/set host email config between tests without env var races
      "shared/email.ts:setHostEmailConfigForTest",
      "shared/email.ts:resetHostEmailConfig",
      // Timezone validation utility (timezone now derived from country, but still useful for tests)
      "shared/timezone.ts:isValidTimezone",
      // Attachment size constant (now re-exported from limits.ts, not detected by export patterns)
      "shared/storage.ts:MAX_ATTACHMENT_SIZE",
      // AsyncLocalStorage-based storage config for concurrent test isolation
      "shared/storage.ts:runWithStorageConfig",
      // readLimit used in production (module-level constants) but test pattern doesn't detect same-file usage
      "shared/limits.ts:readLimit",
      // Settings cache TTL constant used by tests to verify caching behavior
      "shared/db/settings.ts:SETTINGS_CACHE_TTL_MS",
      // Set log suppression directly to avoid env var races between parallel tests
      "shared/logger.ts:setSuppressRequestLogs",
      "shared/logger.ts:setSuppressDebugLogs",
      // Rethrow errors in tests without env var races
      "shared/test-overrides.ts:setRethrowErrorsForTest",
      // Override BUILD_TIMESTAMP in tests (compile-time constant can't be changed otherwise)
      "shared/update.ts:setBuildTimestampForTest",
      // Route maps used by API documentation tests (production uses via dynamic import / createRouter)
      "features/api/index.ts:apiRoutes",
      "features/admin/api.ts:adminApiRoutes",
      // Storage delete override for testing fire-and-forget error handling
      "shared/test-overrides.ts:getDeleteOverride",
      "shared/test-overrides.ts:setDeleteOverride",
      "shared/test-overrides.ts:setDeleteOverrideForTest",
      // API key touch override for testing fire-and-forget error handling
      "shared/test-overrides.ts:getTouchOverride",
      "shared/test-overrides.ts:setTouchOverride",
      "shared/test-overrides.ts:setTouchOverrideForTest",
      // Reset the in-memory form re-fill stash between tests
      "shared/form-stash.ts:clearFormStash",
      // Backward-compat wrapper: fires all invalidators unconditionally (no production caller now
      // that client.ts uses invalidateCachesForWrite, but kept for external callers and tests)
      "shared/cache-registry.ts:invalidateCachesForTable",
      // SET-clause column extractor: internal parser exposed for unit testing only
      "shared/db/client.ts:extractUpdateColumns",
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
        // Matches: name(, name., name, (in objects), name: (with type),
        // and name } (when symbol is the trailing entry of an object literal)
        const usagePattern = new RegExp(`\\b${symbolName}\\s*[.(,:}]`);
        if (usagePattern.test(line)) {
          usageCount++;
        }
      }

      return usageCount > 0;
    };

    const isUsedInProductionCode = (
      symbolName: string,
      sourceFile: string,
    ): boolean => {
      // Check if it's used within the same file
      const sourceContent = srcContents.get(sourceFile)!;
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
        if (importPattern.test(srcContents.get(file)!)) {
          return true;
        }
      }

      // Also check .tsx files as importers
      for (const file of tsxFiles) {
        if (importPattern.test(tsxContents.get(file)!)) {
          return true;
        }
      }

      return false;
    };

    /** Check if a symbol is imported in any test file */
    const isUsedInTests = (symbolName: string): boolean => {
      const importPattern = new RegExp(
        `import\\s*\\{[^}]*\\b${symbolName}\\b[^}]*\\}`,
      );

      for (const testFile of testFiles) {
        if (importPattern.test(testContents.get(testFile)!)) {
          return true;
        }
      }
      return false;
    };

    /** Check if a file should be skipped (test utils, libraries, aggregation modules) */
    const shouldSkipFile = (relativePath: string): boolean =>
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
    const findFileViolations = (file: string): string[] => {
      const relativePath = getRelativePath(file);
      const violations: string[] = [];

      const content = srcContents.get(file)!;
      if (isPrimarilyReExportModule(content)) return violations;

      const exports = extractExports(content);

      for (const exportName of exports) {
        const hookKey = `${relativePath}:${exportName}`;
        if (ALLOWED_TEST_HOOKS.includes(hookKey)) continue;

        const usedInProduction = isUsedInProductionCode(exportName, file);

        if (!usedInProduction && isUsedInTests(exportName)) {
          violations.push(
            `${relativePath}: "${exportName}" is exported but only used in tests`,
          );
        }
      }

      return violations;
    };

    test("exports from src/ should be used in production code, not just tests", async () => {
      await ensureLoaded();
      const violations: string[] = [];

      for (const file of srcFiles) {
        const relativePath = getRelativePath(file);
        if (shouldSkipFile(relativePath)) continue;

        const fileViolations = findFileViolations(file);
        violations.push(...fileViolations);
      }

      expect(violations).toEqual([]);
    });
  });

  describe("no redundant constant arguments", () => {
    /**
     * Detects functions where a given positional argument is *always* passed
     * the same constant literal across every call site. When a parameter never
     * varies it is dead flexibility — the value belongs in a default parameter
     * or a module constant, not repeated at every call.
     *
     * Example violation: `fooMethod("foo", bar)` and `fooMethod("foo", baz)`
     * everywhere → arg #0 is always "foo" and should be a default.
     *
     * Only literal arguments are considered (strings, numbers, booleans, null,
     * undefined, template literals). Variable/expression arguments are ignored
     * because identical *names* rarely mean identical *values*.
     */

    /** Minimum number of call sites before a constant argument is suspicious. */
    const MIN_CALL_SITES = 3;

    /**
     * Built-in string/array/number methods whose constant literal arguments are
     * idiomatic, not redundant (e.g. `padStart(2, "0")`, `toFixed(2)`). These
     * share names with no application function, so ignoring them is safe.
     */
    const IGNORED_CALLEES = new Set([
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
    const ALLOWED_CONSTANT_ARGS = [
      // Built-in parseInt/Number.parseInt should always pass an explicit radix.
      "parseInt#1",
    ];

    /** True for arguments that are constant literals (not variables/expressions). */
    const isConstantLiteral = (arg: string): boolean => {
      if (/^["'`]/.test(arg)) return true;
      if (/^-?\d/.test(arg)) return true;
      return (
        arg === "true" ||
        arg === "false" ||
        arg === "null" ||
        arg === "undefined"
      );
    };

    type Site = { args: string[]; file: string; line: number };

    /** Collect call sites keyed by callee name across all production source. */
    const collectCallSites = (): Map<string, Site[]> => {
      const byName = new Map<string, Site[]>();
      // Production call sites only (src + tsx). This rule is about production
      // API design — pooling test call sites would flag production functions
      // for constants only tests happen to pass, forcing production default
      // params from test patterns. So, like in-memory-state and test-only
      // exports, it stays src-scoped.
      const record = (file: string, content: string): void => {
        const relativePath = getRelativePath(file);
        for (const call of extractCallSites(content)) {
          const sites = byName.get(call.name) ?? [];
          sites.push({ args: call.args, file: relativePath, line: call.line });
          byName.set(call.name, sites);
        }
      };
      for (const file of srcFiles) record(file, srcContents.get(file)!);
      for (const file of tsxFiles) record(file, tsxContents.get(file)!);
      return byName;
    };

    /** Describe a single redundant-argument violation for a callee. */
    const findRedundantArg = (name: string, sites: Site[]): string | null => {
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

    test("functions should not always receive the same constant argument", async () => {
      await ensureLoaded();
      const violations: string[] = [];
      for (const [name, sites] of collectCallSites()) {
        const violation = findRedundantArg(name, sites);
        if (violation) violations.push(violation);
      }
      violations.sort();
      expect(violations).toEqual([]);
    });
  });
});
