/** The policy allow-lists of the code-quality integration guard: which
 * existing files are exempt from a rule, and which exports are intentional
 * test hooks. They describe this codebase rather than the rules, so they
 * live beside the guard as data, apart from the scan machinery. */

/** Library/infrastructure modules - okay to have unused exports */
export const LIBRARY_PATHS = [
  "fp.ts", // FP utility library
  "shared/jsx/jsx-runtime.ts", // JSX compiler runtime
  "shared/jsx/jsx-dev-runtime.ts", // JSX dev runtime
  "shared/asset-paths.ts", // Build-time config consumed by .tsx templates
];

/** Index modules that only re-export from sub-modules */
export const AGGREGATION_MODULES = [
  "shared/db/index.ts",
  "shared/rest/index.ts",
  "templates/index.ts",
];

/* jscpd:ignore-start -- a list of strings, not code */
/**
 * Exports that exist only for tests to reach.
 *
 * Format: "file:exportName"
 */
export const ALLOWED_TEST_HOOKS: string[] = [
  // Whole-ledger reads. Tests assert money movements with them; production
  // reads the ledger by account, by event, or by page.
  "shared/accounting/queries.ts:allTransfers",
  // The Overview figures worked out from a list of attendees. The site reads
  // them with SQL. Tests use this as the reference that the SQL must match.
  "ui/templates/admin/listings/overview.tsx:overviewStatsFromAttendees",
  // Dev/test-only switch for the settings read audit (no-op in production)
  "shared/db/settings-audit.ts:setSettingsAuditEnabled",
  // Reset cached I18N_REPLACEMENTS replacer + compiled formats between tests
  "shared/i18n.ts:resetI18nForTest",
  // Reset cached effective domain between tests
  "shared/config.ts:resetEffectiveDomain",
  "shared/config.ts:setEffectiveDomainForTest",
  // Reset cached demo mode between tests
  "shared/demo/mode.ts:resetDemoMode",
  "shared/demo/mode.ts:setDemoModeForTest",
  // AsyncLocalStorage-based storage config for concurrent test isolation
  "shared/storage.ts:runWithStorageConfig",
  // Suite-level storage config setter for describeWithEnv's `storage` option
  "shared/storage.ts:setStorageConfigForTest",
  // Lower-level deploy primitive: exposed so unit tests can test asset-URL → deploy in isolation
  // without going through the full fetchAndDownloadRelease path used by deployLatestReleaseToScript.
  "shared/update.ts:deployRelease",
  // Route map used by API documentation tests (production uses via createRouter)
  "features/admin/api.ts:adminApiRoutes",
  // Reached in production through a public page handler:
  // features/app/prefix-handlers.ts dynamically imports the pages module and
  // picks the handler off the namespace object, which the named-clause scanner
  // cannot see.
  "features/public/pages.ts:handlePublicContactSubmit",
];
/* jscpd:ignore-end */
