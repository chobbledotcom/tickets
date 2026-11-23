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
  // production caller. A module leaves this list when its last unconsumed
  // export gains a caller.
  "shared/ledger/reconcile.ts", // reconcileExternal, reconcileLegs
  "shared/accounting/queries.ts", // whole-account reads
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

/* jscpd:ignore-start -- a list of strings, not code */
/**
 * Exports that exist only for tests to reach.
 *
 * Format: "file:exportName"
 */
export const ALLOWED_TEST_HOOKS: string[] = [
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
