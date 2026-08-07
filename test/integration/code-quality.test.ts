import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
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
  getAllFilesWithExt,
  type NamedTypeShape,
  type Site,
} from "#test/scripts/code-quality/detectors.ts";
import { detectRelativeImport } from "#test/scripts/code-quality/relative-import.ts";

/**
 * Integration guard for the code-quality rules: it scans the real `src/`+`test/`
 * tree and asserts there are zero violations. The detection logic itself lives
 * in `test/scripts/code-quality/detectors.ts` and is proven with crafted fixtures in
 * `test/scripts/code-quality/detectors.test.ts` — this file is only the "is the live
 * codebase clean?" half. The policy allow-lists (which existing files are
 * exempt, which test hooks are intentional) live here, since they describe this
 * codebase rather than the rules.
 */

const currentDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(currentDir, "../..");
const SRC_DIR = join(currentDir, "../../src");
const TEST_DIR = join(currentDir, "../../test");
const SCRIPTS_DIR = join(currentDir, "../../scripts");
const CLI_DIR = join(currentDir, "../../cli");
const E2E_PAYMENTS_DIR = join(currentDir, "../../e2e-payments");

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
  // The site-pages feature is being wired in incrementally,
  // foundation-first: the pure core + DB layer landed before the admin CRUD /
  // public route / recursive-nav slices that consume them, so — like the
  // ledger modules above — their exports have no production caller yet. Each
  // module loses its exemption as the slice that consumes it lands.
  "shared/site-pages/core.ts",
  "shared/db/site-pages.ts",
  "shared/db/site-page-items.ts",
];

/** Index modules that only re-export from sub-modules */
const AGGREGATION_MODULES = [
  "shared/db/index.ts",
  "shared/rest/index.ts",
  "templates/index.ts",
];

/**
 * Object shapes that two or more differently-named types legitimately share.
 * The duplicate-type-shape rule normally wants one reusable type instead of
 * several identical ones (see the {@link findDuplicateTypeShapes} guard below),
 * but these are *coincidental* structural matches across unrelated concepts —
 * minimal `{ key, value }` / `{ label, value }` / `{ id, name }` pairs and
 * role-specific context types that happen to carry the same fields. Unifying
 * them would couple modules that have nothing to do with each other and hide
 * their distinct intent, so each is allowed by its exact member signature (add
 * or rename a field and it re-flags for review). Genuine duplicates — the
 * `{ sql, args }` statement family, the twin `ChildCandidate`, the nav-row and
 * question-data pairs — were unified instead of listed here.
 */
const ALLOWED_DUPLICATE_TYPE_SHAPES: { signature: string; reason: string }[] = [
  {
    reason:
      "Distinct route params (attendee+listing vs listing+attendee) that coincide as two numeric ids.",
    signature: "attendeeId: number; listingId: number",
  },
  {
    reason:
      "A generic {attendee, listing} pairing plus two role-named context types (payment refresh, ticket-token entry) that carry the same two fields for unrelated jobs.",
    signature: "attendee: Attendee; listing: ListingWithCount",
  },
  {
    reason:
      "A server REST error result and a separate client-side QR-refresh wire type; two independent discriminated-union arms that share the failure shape.",
    signature: "error: string; ok: false",
  },
  {
    reason:
      "The minimal {id, name} identity shape, shared coincidentally by a logistics agent, a listing row, and two unrelated select-option types.",
    signature: "id: number; name: string",
  },
  {
    reason:
      "A stored settings key/value row and a rendered admin detail row; a DB shape and a presentation shape that happen to match.",
    signature: "key: string; value: string",
  },
  {
    reason:
      "The generic {label, value} select-option shape, used independently by the date picker and the site-page picker.",
    signature: "label: string; value: string",
  },
  {
    reason:
      "A selector's props and its edit-context, two local view-model types in one logistics component that currently carry the same two fields.",
    signature: "selected: ReadonlySet<number>; users: AgentUserOption[]",
  },
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
  // Settings version bump: used in production by every settings write (same
  // file, which the export scan doesn't credit) and by tests to simulate
  // another isolate's write.
  "shared/db/settings.ts:bumpSettingsVersion",
  // Settings version probe: used in production within settings.ts (same file);
  // exported so tests can assert its missing/unparseable/DB-error branches.
  "shared/db/settings.ts:getCurrentSettingsVersion",
  // Dev/test-only switch for the settings read audit (no-op in production)
  "shared/db/settings-audit.ts:setSettingsAuditEnabled",
  // (settings.ts functions now accessed via settings namespace, not individual exports)
  // Reset cached I18N_REPLACEMENTS replacer + compiled formats between tests
  "shared/i18n.ts:resetI18nForTest",
  // DB version/hash constants used in production but test pattern doesn't detect constant comparison
  "shared/db/migrations.ts:LATEST_UPDATE",
  "shared/db/migrations.ts:SCHEMA_HASH",
  // Backup freshness window used in production (same-file) but test pattern doesn't detect same-file usage
  "shared/db/backup.ts:BACKUP_FRESHNESS_WINDOW_MS",
  // Attendees page size used in production (same-file) but test pattern doesn't detect same-file usage
  "shared/db/attendees/queries.ts:ATTENDEES_PAGE_SIZE",
  // Payments-retention floor guard used in production (same-file: validates
  // PRUNE_PAYMENTS_RETENTION_DAYS at import) but test pattern doesn't detect same-file usage
  "shared/limits.ts:assertPaymentsRetentionSafe",
  // Retention *_DAYS / *_HOURS constants used in production (same-file: derive
  // the *_MS derivatives that prune.ts imports) but the pattern can't detect
  // same-file arithmetic (`X * DAY_MS` — `*` isn't in its usage character class).
  "shared/limits.ts:PRUNE_PAYMENTS_RETENTION_DAYS",
  "shared/limits.ts:PRUNE_SESSIONS_RETENTION_DAYS",
  "shared/limits.ts:PRUNE_LOGINS_RETENTION_DAYS",
  "shared/limits.ts:PRUNE_TOKENS_RETENTION_DAYS",
  "shared/limits.ts:PRUNE_SUMUP_RETENTION_HOURS",
  "shared/limits.ts:PRUNE_UNUSED_STRINGS_RETENTION_DAYS",
  "shared/limits.ts:PRUNE_CONTACTS_RETENTION_DAYS",
  "shared/limits.ts:ADDRESS_CACHE_DAYS",
  "shared/limits.ts:PRUNE_INTERVAL_HOURS",
  // Reset cached Square client between tests
  "shared/square.ts:resetSquareClient",
  // Raw attendee fetch for testing encrypted data (production uses batched getListingWithAttendeesRaw)
  "shared/db/attendees/queries.ts:getAttendeesRaw",
  // Single attendee fetch for tests (production uses batched getListingWithAttendeeRaw)
  "shared/db/attendees/queries.ts:getAttendeeOrNull",
  // Listing activity log fetch for tests (production uses the batched nullable reader)
  "shared/db/activity-log.ts:getListingActivityLog",
  // Token format check used by CSRF tests (production verifies via verifySignedCsrfToken)
  "shared/csrf.ts:isSignedCsrfToken",
  // Response cookie helper used by auth tests (production sets cookies directly)
  "features/utils.ts:withCookie",
  // Role guard consumed in production only same-file (by deliveryPage, which
  // deliveries.ts uses); the scan can't see same-file usage, but the
  // authorization matrix test asserts it admits exactly its admin levels.
  "features/auth.ts:requireDeliveryOr",
  // Reset cached effective domain between tests
  "shared/config.ts:resetEffectiveDomain",
  "shared/config.ts:setEffectiveDomainForTest",
  // Detach the global Sentry client between test files
  "shared/sentry.ts:resetSentryForTest",
  // Reset cached demo mode between tests
  "shared/demo/mode.ts:resetDemoMode",
  "shared/demo/mode.ts:setDemoModeForTest",
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
  // Suite-level storage config setter for describeWithEnv's `storage` option
  "shared/storage.ts:setStorageConfigForTest",
  // readLimit used in production (module-level constants) but test pattern doesn't detect same-file usage
  "shared/limits.ts:readLimit",
  // Set log suppression directly to avoid env var races between parallel tests
  "shared/logger.ts:setSuppressRequestLogs",
  "shared/log-settings.ts:setSuppressDebugLogs",
  // Rethrow errors in tests without env var races
  "shared/test-overrides.ts:setRethrowErrorsForTest",
  // Override BUILD_TIMESTAMP / BUILD_COMMIT in tests (compile-time constants can't be changed otherwise)
  "shared/update.ts:setBuildTimestampForTest",
  "shared/update.ts:setBuildCommitForTest",
  // Lower-level deploy primitive: exposed so unit tests can test asset-URL → deploy in isolation
  // without going through the full fetchAndDownloadRelease path used by deployLatestReleaseToScript.
  "shared/update.ts:deployRelease",
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
  // Image transcode entry point: production uses it via a dynamic import in
  // storage.ts (uploadImageTargets) so the ~1MB codec wasm loads only on the
  // first upload, never at cold boot — invisible to the static import scanner.
  "shared/images/transcode.ts:transcodeToWebp",
];

const getAllTsFiles = (dir: string): Promise<string[]> =>
  getAllFilesWithExt(dir, ".ts");

/** `.js`/`.jsx` files in every in-scope tree (src, test, scripts, cli,
 *  e2e-payments) — hand-written browser source like
 *  `src/ui/client/scanner.js`, distinct from build artifacts. The
 *  parent-import rule scans these so a script entry can't bypass it just by
 *  sitting in a `.js` file. {@link isBuildArtifactPath} filters out the
 *  `src/ui/static/` esbuild output and `dist/` edge bundle. */
const getAllJsFiles = async (): Promise<string[]> => {
  const dirs = [SRC_DIR, TEST_DIR, SCRIPTS_DIR, CLI_DIR, E2E_PAYMENTS_DIR];
  const exts = [".js", ".jsx"];
  const perDirExt = await Promise.all(
    dirs.flatMap((dir) => exts.map((ext) => getAllFilesWithExt(dir, ext))),
  );
  return perDirExt.flat().filter((f) => !isBuildArtifactPath(f));
};

/** `.tsx` files across every in-scope tree. The template-aware rules
 *  (parent-import is the first one) scan these in addition to the `.ts`
 *  lists so a `.tsx` file can't bypass the rule by sitting outside `src/`. */
const getAllTsxFiles = async (): Promise<string[]> => {
  const dirs = [SRC_DIR, TEST_DIR, SCRIPTS_DIR, CLI_DIR, E2E_PAYMENTS_DIR];
  const perDir = await Promise.all(
    dirs.map((dir) => getAllFilesWithExt(dir, ".tsx")),
  );
  return perDir.flat();
};

/** Whether `fullPath` is a generated/build-output path (skipped by every
 *  source-scanning rule). `src/ui/static/` holds esbuild's bundled `.js`
 *  output (rebuilt from `.ts` by `scripts/build-static-assets.ts`) and
 *  `dist/` holds the bundled edge script, so neither is source. */
const isBuildArtifactPath = (fullPath: string): boolean =>
  fullPath.includes(`${sep}ui${sep}static${sep}`) ||
  fullPath.includes("/ui/static/") ||
  fullPath.includes(`${sep}dist${sep}`) ||
  fullPath.includes("/dist/");

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
  relativePath === "test/integration/code-quality.test.ts" ||
  relativePath.startsWith("test/scripts/code-quality/");

describe("code quality", () => {
  /** Cached file lists and contents, populated once on first use */
  let srcFiles: string[];
  let srcContents: Map<string, string>;
  let testFiles: string[];
  let testContents: Map<string, string>;
  /** Production `.tsx` templates — the templates the app actually renders.
   *  Passed to the production-only rules (test-only-exports, redundant-args)
   *  as additional production source. Stays scoped to `src/` so `.test.tsx`
   *  files under `test/` are never credited as production use. */
  let srcTsxFiles: string[];
  let srcTsxContents: Map<string, string>;
  /** Every `.tsx` file in every in-scope tree. Used by the parent-import rule
   *  (and any other rule that wants every template regardless of whether it's
   *  production code or a test). */
  let allTsxFiles: string[];
  let allTsxContents: Map<string, string>;
  /** Hand-written `.js`/`.jsx` files in every in-scope tree. Scanned by the
   *  parent-import rule so a script entry in `.js` can't bypass it. */
  let jsFiles: string[];
  let jsContents: Map<string, string>;
  let scriptsFiles: string[];
  let scriptsContents: Map<string, string>;
  let cliFiles: string[];
  let cliContents: Map<string, string>;
  let e2eFiles: string[];
  let e2eContents: Map<string, string>;

  const ensureLoaded = async (): Promise<void> => {
    if (srcContents) return;
    const [sf, tf, srcTxf, allTxf, jsf, scf, cf, ef] = await Promise.all([
      getAllTsFiles(SRC_DIR),
      getAllTsFiles(TEST_DIR),
      getAllFilesWithExt(SRC_DIR, ".tsx"),
      getAllTsxFiles(),
      getAllJsFiles(),
      getAllTsFiles(SCRIPTS_DIR),
      getAllTsFiles(CLI_DIR),
      getAllTsFiles(E2E_PAYMENTS_DIR),
    ]);
    srcFiles = sf;
    testFiles = tf;
    srcTsxFiles = srcTxf;
    allTsxFiles = allTxf;
    jsFiles = jsf;
    scriptsFiles = scf;
    cliFiles = cf;
    e2eFiles = ef;
    const [sc, tc, srcTxc, allTxc, jsc, scc, cc, ec] = await Promise.all([
      readAllFiles(srcFiles),
      readAllFiles(testFiles),
      readAllFiles(srcTsxFiles),
      readAllFiles(allTsxFiles),
      readAllFiles(jsFiles),
      readAllFiles(scriptsFiles),
      readAllFiles(cliFiles),
      readAllFiles(e2eFiles),
    ]);
    srcContents = sc;
    testContents = tc;
    srcTsxContents = srcTxc;
    allTsxContents = allTxc;
    jsContents = jsc;
    scriptsContents = scc;
    cliContents = cc;
    e2eContents = ec;
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

  /** Iterate the in-scope files, skipping the code-quality folder's own
   *  fixtures (which legitimately use the patterns the rules forbid, e.g.
   *  `'import "../x.ts"'` as detector input). Each surviving file is handed to
   *  the caller alongside its repo-relative path and contents. */
  const forEachScannedFile = (
    files: string[],
    contents: Map<string, string>,
    fn: (file: string, relativePath: string, fileContents: string) => void,
  ): void => {
    for (const file of files) {
      const relativePath = repoRelative(file);
      if (isCodeQualityFile(relativePath)) continue;
      fn(file, relativePath, contents.get(file)!);
    }
  };

  /**
   * Scan one file set line by line, collecting violations via a detector.
   * Skips code-quality's own files so its rule literals never self-flag.
   */
  const collectLineViolations = (
    files: string[],
    contents: Map<string, string>,
    detect: (
      relativePath: string,
      line: string,
      lineNum: number,
    ) => string | null,
  ): string[] => {
    const violations: string[] = [];
    forEachScannedFile(files, contents, (_file, relativePath, fileContents) => {
      const lines = fileContents.split("\n");
      let lineNum = 0;
      for (const line of lines) {
        lineNum++;
        const v = detect(relativePath, line, lineNum);
        if (v) violations.push(v);
      }
    });
    return violations;
  };

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
    return [
      ...collectLineViolations(srcFiles, srcContents, detect),
      ...collectLineViolations(testFiles, testContents, detect),
    ];
  };

  /** Run a whole-file detector (one call per file, receiving the full
   *  contents) over every in-scope tree. The detector returns every
   *  violation it finds in the file, so one call surfaces every form the
   *  rule forbids — single-line, multi-line, with comments in the gap —
   *  and a returned empty array means the file is clean. */
  const collectFileViolations = (
    files: string[],
    contents: Map<string, string>,
    detect: (relativePath: string, contents: string) => string[],
  ): string[] => {
    const violations: string[] = [];
    // Whole-file detectors (like detectRelativeImport) skip comments and
    // string literals themselves, so code-quality's own files don't need the
    // blanket skip the line-level detectors use — they can't self-flag.
    for (const file of files) {
      const relativePath = repoRelative(file);
      violations.push(...detect(relativePath, contents.get(file)!));
    }
    return violations;
  };

  const scanSourceFiles = async (
    detect: (relativePath: string, contents: string) => string[],
  ): Promise<string[]> => {
    await ensureLoaded();
    return [
      ...collectFileViolations(srcFiles, srcContents, detect),
      ...collectFileViolations(testFiles, testContents, detect),
      ...collectFileViolations(allTsxFiles, allTsxContents, detect),
      ...collectFileViolations(jsFiles, jsContents, detect),
      ...collectFileViolations(scriptsFiles, scriptsContents, detect),
      ...collectFileViolations(cliFiles, cliContents, detect),
      ...collectFileViolations(e2eFiles, e2eContents, detect),
    ];
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
            srcTsxContents,
            testContents,
            ALLOWED_TEST_HOOKS,
            [scriptsContents, cliContents, e2eContents],
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
      for (const file of srcTsxFiles) record(file, srcTsxContents.get(file)!);
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

  describe("no duplicate type shapes", () => {
    /**
     * Collect every object-shaped `type`/`interface` across production source
     * (src + tsx), keyed by file. Prefer generic, reusable objects: two
     * differently-named types with identical members should be one shared type.
     * Coincidental cross-domain matches live in ALLOWED_DUPLICATE_TYPE_SHAPES.
     */
    const collectTypeShapes = (): NamedTypeShape[] => {
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
      await ensureLoaded();
      const allowed = ALLOWED_DUPLICATE_TYPE_SHAPES.map((a) => a.signature);
      const violations = findDuplicateTypeShapes(collectTypeShapes(), allowed);
      expect(violations).toEqual([]);
    });
  });
});
