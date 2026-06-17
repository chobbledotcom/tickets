# Settings: migrate from "load everything" to keyed, on-demand loading

## Problem

Every request runs `settings.loadAll()` in `prepareRequestEnvironment`
(`src/features/index.ts:519`). That:

- runs `SELECT key, value FROM settings` — **all** rows
  (`src/shared/db/settings.ts:588`), and
- **decrypts every encrypted key in parallel** on each cold load
  (`buildSnapshot`, `src/shared/db/settings.ts:566-575`, 32 encrypted keys
  today), then
- holds the full decrypted snapshot in memory for the isolate.

It is cached for 60 s per isolate (`SETTINGS_CACHE_TTL_MS`), so it is not
literally every page load — but the *shape* of the cost is "all settings, all
the time". The practical consequence is the one the user named: there is a
disincentive to add new settings, or settings with large values (e.g. long
HTML email templates, image blobs, certs), because each one adds to the
fetch-and-decrypt-everything cost paid by every isolate, on routes that don't
use them.

## Goal

1. Each route **declares the settings it needs up front**, in a static const
   kept next to the route, in terms of reusable **setting bundles**.
2. Just before a route runs, we **fetch only the settings it declared**,
   served from a **keyed, per-setting cache** (the same caching shape used for
   listings — `src/shared/db/keyed-cache.ts`), fetching and decrypting only the
   missing keys.
3. The existing **sync getter API stays the same** (`settings.businessEmail`,
   `settings.stripe`, `settings.email`, …) so the ~40 call-site clusters across
   the app do not change. We only change *how the snapshot gets populated*:
   from "all keys, eagerly" to "declared keys, on demand".

Keeping the getters sync is the load-bearing decision: it means this is a
data-loading change, not a rewrite of every consumer.

## Why a keyed cache, not the current single-snapshot cache

The listings cache (`createKeyedCache`) already demonstrates the target
behaviour: per-entry TTL, `fetchByKeys` loads **only the misses** in one query,
single-record reads never trigger a whole-table load, and writes
`invalidate()` immediately within the isolate. Settings want the same: load
only the declared keys, decrypt only those, cache each decrypted value with its
own expiry.

`createKeyedCache` itself is entity-shaped (numeric `id` + secondary string
key + ordered "all" view) and is a poor fit for `key → value` string pairs. So
we build a small **`settingsCache`** in the same spirit, backed directly by the
existing `ttlCache<string, string>` primitive from `#fp` (the same primitive
`createKeyedCache` is built on). It is deliberately simpler than
`createKeyedCache` — no ordered view, no numeric id.

## Design

### 1. Setting bundles (the "static consts")

Settings are already consumed in natural clusters. Define named bundles, each a
`readonly` array of `CONFIG_KEYS` values, colocated with the feature that owns
them. Examples:

```ts
// src/shared/db/setting-bundles.ts
export const SETTING_BUNDLES = {
  theme: [CONFIG_KEYS.THEME],
  // country drives currency/timezone/phone_prefix derived fields
  locale: [CONFIG_KEYS.COUNTRY],
  siteChrome: [
    CONFIG_KEYS.WEBSITE_TITLE,
    CONFIG_KEYS.HEADER_IMAGE_URL,
    CONFIG_KEYS.THEME,
    CONFIG_KEYS.SHOW_PUBLIC_SITE,
    CONFIG_KEYS.CUSTOM_DOMAIN,
  ],
  stripe: [
    CONFIG_KEYS.STRIPE_SECRET_KEY,
    CONFIG_KEYS.STRIPE_WEBHOOK_SECRET,
    CONFIG_KEYS.STRIPE_WEBHOOK_ENDPOINT_ID,
  ],
  emailTemplates: [ /* the 6 EMAIL_TPL_* keys */ ],
  appleWallet: [ /* the 5 APPLE_WALLET_* keys */ ],
  // …one bundle per existing sub-namespace
} as const satisfies Record<string, readonly StringSettingKey[]>;
```

Bundles mirror the existing sub-namespaces (`settings.email`, `.stripe`,
`.square`, `.sumup`, `.smsGateway`, `.appleWallet`, `.googleWallet`,
`.setup`) plus a few cross-cutting ones (`theme`, `locale`, `siteChrome`). A
route declares an array of bundle names; the loader flattens + dedupes the
union of their keys.

**Keeping bundles honest.** A bundle that under-declares is the failure mode to
guard against (a getter returns a stale/default value because its key was never
loaded). The safeguard is a **debug/dev assertion mode**: `snap()`
(`settings.ts:329`) records every snapshot key actually read during a request;
in test/dev we assert that every read key was in the request's declared key
set, and fail the test naming the route and the missing bundle. This turns "I
forgot to declare a setting" into a failing test rather than a production bug,
and every route exercised by the suite is therefore proven complete.

**No "load everything" escape hatch.** Routes that genuinely read most settings
(notably the admin settings page, ~40 settings) declare an explicit, named
bundle — e.g. an `adminSettingsPage` bundle, or a composed list of the
sub-namespace bundles — rather than falling back to loading the full set. This
is deliberate: `loadAll` is being removed (see §6), so there is no
"requiresAll" mode to lean on. The dev assertion keeps even these large bundles
honest, and listing the keys explicitly makes the cost of a broad route visible
in code review.

### 2. Bundles, `withSettings`, and the dev assertion — ⏳ NEXT (Phase 2)

This is the next phase to implement. It adds the declaration machinery but
changes no runtime behaviour: with the migration bridge in place, undeclared
routes still get a full load, so the app behaves exactly as it does after
Phase 1. Three pieces:

#### 2a. Bundle definitions, colocated

The admin settings UI is already split by domain — `settings-stripe.ts`,
`settings-email.ts`, `settings-square.ts`, `settings-sms.ts`,
`settings-wallets.ts`, `settings-domains.ts`, `settings-general.ts`,
`settings-logistics.ts`, `settings-superuser.ts`,
`settings-email-templates.ts`, `settings-header-image.ts`,
`settings-statuses.ts` — so each bundle lives in the file that owns those
settings, exported as a `readonly` tuple of `CONFIG_KEYS` values:

```ts
// src/features/admin/settings-stripe.ts
export const STRIPE_SETTINGS = [
  CONFIG_KEYS.STRIPE_SECRET_KEY,
  CONFIG_KEYS.STRIPE_WEBHOOK_SECRET,
  CONFIG_KEYS.STRIPE_WEBHOOK_ENDPOINT_ID,
] as const;
```

A bundle is just `readonly StringSettingKey[]` (or `readonly string[]` for keys
without snapshot fields). Cross-cutting bundles that don't belong to a single
admin file — `LOCALE` (just `COUNTRY`, which fans out to currency/timezone/
phone-prefix), `SITE_CHROME` (website title, header image, theme,
show-public-site, custom domain), `PAYMENTS` (payment_provider + the active
provider's keys) — live in a new `src/features/settings-bundles.ts`. There is no
single giant registry; `settings-bundles.ts` only holds the genuinely shared
ones and may re-export the per-file bundles for convenience.

Type the bundle keys against `StringSettingKey` where possible so a typo or a
renamed `CONFIG_KEYS` entry is a compile error.

#### 2b. `withSettings` wrapper

Attach the required keys to the handler as a static, inspectable property:

```ts
// src/features/router.ts
const SETTINGS_KEYS = Symbol("settingsKeys");

export const withSettings = <P extends string>(
  bundles: readonly (readonly string[])[],
  handler: TypedRouteHandler<P>,
): TypedRouteHandler<P> => {
  (handler as WithSettings)[SETTINGS_KEYS] = unique(bundles.flat());
  return handler;
};

export const settingsKeysOf = (h: RouteHandlerFn): readonly string[] | null =>
  (h as WithSettings)[SETTINGS_KEYS] ?? null;
```

Registered at the route:

```ts
"GET /ticket/:slug": withSettings([SITE_CHROME, LOCALE], handleTicketGet),
```

The wrapper returns the handler unchanged except for the attached metadata, so
it composes with the existing `defineRoutes` typing and needs no router
rewrite. `compileRoutes` already stores the handler reference; the
matcher just needs to surface `settingsKeysOf(handler)` alongside the match (see
§4). `settingsKeysOf` returning `null` means "undeclared" → migration bridge.

A route that needs everything (the admin settings *page*, which reads ~40
settings to render the form) declares an explicit `ADMIN_SETTINGS_PAGE` bundle —
the union of every per-file bundle — not a magic "all" flag.

#### 2c. Dev assertion mode (the safety net)

This is what makes removing `loadAll` safe. Wire a per-request "declared key
set" and have `snap()` (`settings.ts`) record every snapshot key actually read.
In test/dev only (gated on an env flag or the existing test-mode detection), at
the end of a request assert that every key read was either in the route's
declared set or in the fixed infra bundle (§4); on a miss, throw an error naming
the route, the offending key, and the bundle it most likely belongs to.

Mechanics:

- Add an internal `recordRead(key)` called from `snap()`; collect into a
  per-request set (an `AsyncLocalStorage`-style context already exists for flash
  / saved-form data — reuse that mechanism rather than a global).
- Map snapshot field names back to `CONFIG_KEYS` for the comparison (the special
  fields like `currency`/`timezone` map back to `COUNTRY`; `payment_provider`
  and `payment_provider_setting` map back to `PAYMENT_PROVIDER`).
- The assertion is **dev/test-only** — it must be a strict no-op in production
  (no per-read bookkeeping cost on the hot path beyond a cheap branch).

The payoff: every route exercised by the test suite is *proven* to declare
everything it reads, so when the bridge is deleted in §6 there are no surprises.

### 3. The settings cache + scoped load — ✅ DONE (Phase 1)

This phase shipped. The shape ended up slightly different from the original
sketch: rather than introduce a *second* decrypted `ttlCache` alongside the
existing raw cache (which would have split state and complicated writes), the
existing raw-row cache was extended to support partial loads, and decrypted
values continue to live in the snapshot (`data`). What landed in
`src/shared/db/settings.ts`:

- **`CacheState` now tracks partiality.** It holds `values` (rows loaded so
  far), `loaded` (the set of keys resolved — *present or absent* in the DB, so a
  partial load never re-queries a key it already fetched), a `full` flag (set by
  `loadAll` after a `SELECT *`, meaning every key counts as loaded), and `time`
  for TTL expiry.

- **`loadKeys(keys)`** — the on-demand loader. It resets the cache if stale,
  computes `missing = keys not yet loaded`, runs **one
  `SELECT … WHERE key IN (…)`** for just those, records them in `values`/`loaded`,
  and resolves them into the snapshot via `applyKeys`. No-op when everything
  requested is already loaded.

- **Per-key resolution.** `buildSnapshot`'s monolithic loop became
  `SPECIAL_APPLIERS` (a map from config key → snapshot mutation for the
  non-string fields: country+derived, theme, the booleans, payment-provider
  parsing, booking-fee default, square-sandbox) plus `applyKey`/`applyKeys`
  which handle plaintext (verbatim) and encrypted (parallel `decrypt`) keys.
  Both `loadAll` and `loadKeys` share these resolvers, so there is exactly one
  definition of "raw row → snapshot field".

- **`loadAll` kept its `SELECT *`** so the raw cache still holds every row.
  This matters because `getCachedRaw` is a general escape hatch read for
  arbitrary keys not in any bundle (e.g. `db_schema_hash` in
  `features/admin/debug.ts`, `fieldsApi.getSettingCached`). `loadAll` is now
  effectively "load everything and mark `full`"; `loadKeys` is the partial
  counterpart.

- **First real consumer:** `isSetupComplete` now calls
  `loadKeys([SETUP_COMPLETE])` instead of triggering a full load.

- Writes (`writeRaw`/`deleteRaw`) still update the snapshot and raw cache in
  place; they now also mark the key `loaded` so a later partial load trusts the
  written value.

**Not yet done (intentionally deferred to later phases):** the generation
counter for read/write races. The current in-place write + `loaded` marking is
correct for the single-threaded isolate model already in use; the generation
counter from `keyed-cache.ts:75` should be added when/if concurrent in-flight
partial loads become a real race (revisit during §5).

### 4. Wire the scoped load into the request lifecycle — ⏳ Phase 3

Today `prepareRequestEnvironment` (`src/features/index.ts:516`) calls
`settings.loadAll()` *before* routing, because it needs `CUSTOM_DOMAIN` for
`loadEffectiveDomain` and the `LAST_PRUNED_*` timestamps for `maybeRunPrunes`.
The matched route — and therefore its declared bundles — isn't known until
`routeAndFinalize` → `handleRequestInternal` runs later. The wiring must bridge
that gap without reordering the whole pipeline.

**Approach: a fixed infra bundle now, route bundles at dispatch.**

1. **Infra bundle.** Define `INFRA_SETTINGS` = the keys the pre-routing pipeline
   itself touches: `CUSTOM_DOMAIN`, `CUSTOM_DOMAIN_LAST_VALIDATED` (domain
   resolution), the five `LAST_PRUNED_*` keys (pruning), and `SETUP_COMPLETE`
   (setup gate). In `prepareRequestEnvironment`, replace `loadAll()` with
   `settings.loadKeys(INFRA_SETTINGS)`. This is a handful of plaintext keys —
   no decryption, one tiny query — versus today's whole-table load.

2. **Route bundles at dispatch.** Surface the matched handler's
   `settingsKeysOf(handler)` from the router (return it alongside `handler`/
   `params` from `matchRequest`, or expose a `resolveRoute` that the dispatcher
   calls). Immediately before invoking the handler in `createRouter`'s returned
   function (or in `routeAndFinalize`), call `settings.loadKeys(keys)` for the
   declared keys. Because `loadKeys` is incremental and the infra keys are
   already loaded+fresh, this only fetches the route's *additional* keys.

3. **Migration bridge.** When `settingsKeysOf(handler)` is `null` (undeclared),
   call `settings.loadAll()` instead — preserving today's behaviour for routes
   not yet migrated. This branch is deleted in §6.

Edge cases to handle in this phase:

- **Static assets / early returns** (`routeStatic`, `trackingParamRedirect`,
  `initializeDatabaseForPath`) run before `prepareRequestEnvironment` and must
  not need settings — confirm they don't, or give them the infra bundle.
- **404 / no route matched** — no declared keys; the infra bundle is enough to
  render the not-found path. Verify the 404 renderer doesn't read undeclared
  settings (if it reads `SITE_CHROME` for layout, fold that into the infra
  bundle or a dedicated "layout" bundle loaded for all HTML responses).
- **Shared layout/chrome.** Most HTML pages render a common header/footer that
  reads website title, theme, header image. Rather than repeat `SITE_CHROME` in
  every bundle, consider loading a small **layout bundle** for any route that
  returns HTML (orthogonal to the route's data bundles). Decide this explicitly
  in Phase 3 — it's the most likely source of "undeclared key" assertion hits.

### 5. Writes / invalidation — ⏳ Phase 3/4 (mostly already correct)

Phase 1 already keeps writes correct: `writeRaw`/`deleteRaw` update the DB, the
snapshot, and the raw cache in place, and now also mark the key `loaded`.
`invalidateCache` clears the cache and resets the snapshot to defaults. No
writer call sites change — `settings.update.*` keeps its surface.

Remaining work, to confirm during Phases 3–4:

- **Read-after-write within a request.** A handler that writes a setting and
  then reads it (or re-renders) must see the new value. The in-place snapshot
  update already guarantees this regardless of whether the key was in the
  request's bundle. Add a test per migrated write route that reads back.
- **Generation counter (deferred from §3).** If concurrent partial loads can
  race a write within an isolate, add the `keyed-cache.ts:75` generation pattern
  to `loadKeys` so a fetch that started before a write can't overwrite it. Only
  needed if profiling shows real concurrency here.
- **`getCachedRaw` consumers.** `db_schema_hash` (debug page) and
  `fieldsApi.getSettingCached` read arbitrary keys via the raw cache. After
  `loadAll` is removed (§6) these must explicitly `loadKeys([...])` the keys they
  read, since nothing loads "everything" any more. Inventory them in Phase 4.

### 6. Remove `loadAll` (priority) — ⏳ Phase 5

`loadAll` is the waste this plan exists to remove, so deleting it is a
first-class deliverable, not cleanup. Once every route declares bundles and the
dev assertion has run green across the full suite:

1. Delete the `settingsKeysOf(...) === null → loadAll()` bridge in the
   dispatcher (§4.3).
2. Make `getCachedRaw` consumers self-sufficient (§5) — each loads the keys it
   reads.
3. Remove `loadAll`, the `full` flag, and the `SELECT *` path from
   `settings.ts`. `loadKeys` and the per-key resolvers are all that remain.
4. Update tests: the ~40 `await settings.loadAll()` calls in the test suite
   (and `test/test-utils/db.ts`) become `await settings.loadKeys([...])` for the
   keys each test asserts on, or a small test helper `loadTestSettings()` that
   loads a representative set. This is the largest mechanical change and should
   be its own commit.

After this, the common request loads a handful of keys instead of 130+, and
adding a new large setting only costs the routes that declare it — removing the
disincentive that motivated the whole effort.

## Migration sequence (incremental, always green)

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Keyed cache + `loadKeys` + per-key resolvers; `loadAll` unchanged (§3) | ✅ done |
| 2 | Bundles, `withSettings`, dev assertion mode; bridge keeps behaviour identical (§2) | ⏳ next |
| 3 | Infra bundle + dispatch-time `loadKeys`; migrate hot public routes (`GET /`, `GET /ticket/:slug`, embeds); resolve the layout-bundle question (§4) | ⏳ |
| 4 | Migrate remaining public + all admin routes (explicit `ADMIN_SETTINGS_PAGE` bundle); make `getCachedRaw` consumers self-sufficient (§5) | ⏳ |
| 5 | Delete the bridge and `loadAll`; convert test `loadAll` calls (§6) | ⏳ |

Each phase keeps the full suite green and 100% coverage. Phases 2 and the early
part of 3 are behaviour-preserving; the win lands incrementally as routes are
migrated in 3–4; phase 5 removes the fallback.

## What does NOT change

- Sync getter API: `settings.businessEmail`, `settings.stripe.hasKey`,
  `settings.email`, derived `settings.currency`, etc.
- `settings.update.*` writer surface.
- `CONFIG_KEYS`, `PLAINTEXT_KEYS`, `ENCRYPTED_KEYS`, the encryption boundary.
- Test override mechanism (`getTestOverrides` / `snap`).

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| A bundle under-declares → getter returns a default/stale value | Dev/test assertion mode fails the offending route's tests (§1) |
| Per-request route→bundle resolution adds overhead before routing | Bundles are static consts; union+dedupe is O(keys); infra bundle is fixed and tiny |
| Cross-isolate staleness from per-key TTL | Same bound as today (per-entry TTL); writes invalidate within the isolate; security gating already hits the DB, not the cache |
| Removing `loadAll` exposes a route that read an undeclared key | The bridge is only removed *after* the dev assertion proves every suite-exercised route is complete; broad routes get explicit bundles in step 4 |

## Resolved decisions

1. **Granularity:** bundles (mapped onto the existing sub-namespaces), with the
   freedom to list bare keys for one-off needs.
2. **Location of `requires`:** colocated with the route via `withSettings`, so
   the declaration sits next to the code that reads the settings.
3. **Fate of `loadAll`:** removed as soon as all routes declare bundles (§6).
   It is a temporary migration bridge only — there is no permanent "load
   everything" mode, because that is exactly the waste being eliminated.
