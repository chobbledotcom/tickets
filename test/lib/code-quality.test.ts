import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  detectAliasing,
  detectModuleLevelLet,
  detectThenUsage,
  extractCallSites,
  findInMemoryStateViolations,
  findRawDbViolation,
  findRedundantArg,
  findTestOnlyExportViolations,
  getAllFilesWithExt,
  type Site,
} from "./code-quality/detectors.ts";

/**
 * Integration guard for the code-quality rules: it scans the real `src/`+`test/`
 * tree and asserts there are zero violations. The detection logic itself lives
 * in `./code-quality/detectors.ts` and is proven with crafted fixtures in
 * `./code-quality/detectors.test.ts` — this file is only the "is the live
 * codebase clean?" half. The policy allow-lists (which existing files are
 * exempt, which test hooks are intentional) live here, since they describe this
 * codebase rather than the rules.
 */

const currentDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(currentDir, "../..");
const SRC_DIR = join(currentDir, "../../src");
const TEST_DIR = join(currentDir, "../../test");

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

/** Library/infrastructure modules - okay to have unused exports */
const LIBRARY_PATHS = [
  "fp.ts", // FP utility library
  "shared/jsx/jsx-runtime.ts", // JSX compiler runtime
  "shared/jsx/jsx-dev-runtime.ts", // JSX dev runtime
  "shared/asset-paths.ts", // Build-time config consumed by .tsx templates
  // The transfer ledger (src/shared/ledger + src/shared/accounting) is being
  // wired in incrementally; like fp.ts, some exports have no production
  // caller yet. account.ts and validate.ts are already consumed by the store
  // adapter, so they are no longer exempt — the remaining modules lose their
  // exemption as the event mappers and checkout wiring land.
  "shared/ledger/project.ts",
  "shared/ledger/reverse.ts",
  "shared/ledger/reconcile.ts",
  "shared/checkout-ledger.ts",
  "shared/accounting/store.ts",
  "shared/accounting/queries.ts",
  "shared/accounting/mappers.ts",
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
  // Override BUILD_TIMESTAMP / BUILD_COMMIT in tests (compile-time constants can't be changed otherwise)
  "shared/update.ts:setBuildTimestampForTest",
  "shared/update.ts:setBuildCommitForTest",
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
  // System-note creator: its first production caller (the refunded-but-stored
  // booking warning) lands with the refund-but-store change; the notes module
  // ships the writer alongside its reader, exercised directly by tests until then.
  "shared/db/system-notes.ts:createSystemNote",
];

const getAllTsFiles = (dir: string): Promise<string[]> =>
  getAllFilesWithExt(dir, ".ts");

const getRelativePath = (fullPath: string): string =>
  fullPath.replace(`${SRC_DIR}/`, "");

/**
 * Path relative to the repo root, e.g. "src/foo.ts" or "test/foo.ts". Used by
 * the rules that scan both src and test files (aliasing, module-level let,
 * .then()) so their violation paths are unambiguous.
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

/**
 * Files that *define* the code-quality patterns (in comments, regexes and
 * fixture strings) and so would flag themselves under the line-level scans.
 * They have no real line-level violations of their own.
 */
const isCodeQualityFile = (relativePath: string): boolean =>
  relativePath === "test/lib/code-quality.test.ts" ||
  relativePath.startsWith("test/lib/code-quality/");

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
      await ensureLoaded();
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

  /**
   * Scan src and test files line by line, collecting violations via a detector.
   * Test code is held to the same line-level standards as production code.
   * Returns the combined violation list.
   */
  const scanSourceLines = async (
    detect: (
      relativePath: string,
      line: string,
      lineNum: number,
    ) => string | null,
  ): Promise<string[]> => {
    await ensureLoaded();
    const violations: string[] = [];
    const scan = (files: string[], contents: Map<string, string>): void => {
      for (const file of files) {
        const relativePath = repoRelative(file);
        if (isCodeQualityFile(relativePath)) continue;
        const lines = contents.get(file)!.split("\n");
        let lineNum = 0;
        for (const line of lines) {
          lineNum++;
          const v = detect(relativePath, line, lineNum);
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
      await ensureLoaded();
      const violations: string[] = [];

      for (const file of srcFiles) {
        const relativePath = getRelativePath(file);
        if (shouldSkipFile(relativePath)) continue;

        violations.push(
          ...findTestOnlyExportViolations(
            file,
            relativePath,
            srcContents,
            tsxContents,
            testContents,
            ALLOWED_TEST_HOOKS,
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
    const collectCallSites = (): Map<string, Site[]> => {
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
      for (const file of tsxFiles) record(file, tsxContents.get(file)!);
      return byName;
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
