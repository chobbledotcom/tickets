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
  // The transfer ledger (src/shared/ledger + src/shared/accounting) is built
  // ahead of the payment aggregate that consumes it, so some exports have no
  // production caller. Each entry below names the rule it answers in
  // docs/payment-aggregate-acceptance.md, or says that no rule asks for it. A
  // module leaves this list when its last unconsumed export gains a caller.
  "shared/ledger/reconcile.ts", // reconcileExternal, reconcileLegs: rule 2
  "shared/accounting/queries.ts", // whole-account reads: rules 1 and 3
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
export const AGGREGATION_MODULES = [
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
export const ALLOWED_DUPLICATE_TYPE_SHAPES: {
  signature: string;
  reason: string;
}[] = [
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
export const ALLOWED_TEST_HOOKS: string[] = [
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
  // Service-cost replay message thrown in production (same file, by
  // recordServiceCost) but the pattern doesn't detect same-file usage. Exported
  // so the test asserts the thrown message rather than hardcoding a copy.
  "shared/db/attendees/servicing.ts:COST_REPLAY_MISMATCH",
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
  // Seconds ladder used in production (same-file: UNIT_FORMATTERS references
  // it as a value) but the pattern doesn't detect same-file usage.
  "shared/format-units.ts:formatSeconds",
  // Move table used in production (same-file: LINK_END_MOVES_READER wraps it
  // for squareLinkEndMoveTo, which db/square-link-ends.ts imports) but the
  // pattern doesn't detect same-file usage.
  "shared/payment/square-link-end-machine-spec.ts:LINK_END_MOVES",
];
