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

### 2. Route declares its bundles

Extend route registration so a handler can carry a static `requires`. The
router (`src/features/router.ts`, `defineRoutes`) already maps pattern →
handler; add an optional companion map (or a wrapper) so a route can be
registered as:

```ts
"GET /ticket/:slug": withSettings(["siteChrome", "locale"], handleTicketGet),
```

`withSettings(bundles, handler)` attaches `bundles` as a static property on the
handler function (a const, inspectable before invocation) and returns the
handler unchanged otherwise. During migration only, a route that declares
nothing temporarily falls back to the legacy full load — but this fallback is a
**bridge, not a feature**: it exists solely so the migration can land
incrementally, and it is deleted together with `loadAll` in the final phase
(§6). The end state has **no undeclared routes**.

The declaration lives **with the route**, satisfying "broadcast required
settings up front in a static const we keep up to date". The dev assertion in
§1 keeps it in sync.

### 3. The settings cache + scoped load

```ts
// src/shared/db/settings.ts (internal)
const cache = ttlCache<string, string>(SETTINGS_CACHE_TTL_MS, nowMs);
// stores DECRYPTED values keyed by CONFIG_KEYS string

const loadKeys = async (keys: readonly string[]): Promise<void> => {
  const missing = unique(keys).filter((k) => cache.get(k) === undefined);
  if (missing.length > 0) {
    const rows = await queryAll<Settings>(
      `SELECT key, value FROM settings WHERE key IN (${placeholders(missing)})`,
      missing,
    );
    const raw = new Map(rows.map((r) => [r.key, r.value]));
    // decrypt only the encrypted keys among `missing`, in parallel
    for (const [k, v] of await resolveValues(missing, raw)) cache.set(k, v);
  }
  applyToSnapshot(keys); // write resolved values into `data` for sync getters
};
```

- `loadKeys` fetches a **single `WHERE key IN (...)` query for the misses
  only**, decrypts only the encrypted keys in that set, and caches each
  decrypted value with its own TTL — mirroring `getByKeys` in the keyed cache
  (`keyed-cache.ts:121-133`).
- `applyToSnapshot` writes the resolved values into the existing `data`
  snapshot via `setSnapshotField`, applying the same per-key resolution
  `buildSnapshot` does today: booleans (`=== "true"`), `payment_provider`
  parsing, `booking_fee` default, and the **country-derived** fields
  (`applyCountryDerived` when `COUNTRY` is in the set). This is the existing
  logic, refactored from "loop over all keys" to "resolve a given key" so it
  can run per-bundle.
- A **generation counter** (as in `keyed-cache.ts:75`) drops in-flight fetches
  that raced a write, so a write is never overwritten by an older read.

### 4. Wire into the request lifecycle

In `prepareRequestEnvironment` (`src/features/index.ts:516`), replace the
unconditional `settings.loadAll()` with a scoped load driven by the matched
route's declaration:

1. Resolve the route (the router already does pattern matching) and read its
   `requires` const.
2. Declared → `settings.loadKeys(union of declared bundles' keys)`.
3. Undeclared (migration bridge only) → temporary full load, removed in §6.

One subtlety: `prepareRequestEnvironment` currently runs **before** routing and
itself needs `CUSTOM_DOMAIN` (`loadEffectiveDomain`) and the prune timestamps.
Two options:

- **(a, recommended)** Always pre-load a tiny fixed **infra bundle**
  (`CUSTOM_DOMAIN`, `LAST_PRUNED_*`, `SETUP_COMPLETE`) — the handful of keys the
  request pipeline itself needs — then load the route bundles. This keeps
  `prepareRequestEnvironment` self-contained and cheap.
- (b) Move route resolution before `prepareRequestEnvironment` so the bundle is
  known earlier. More invasive to the lifecycle ordering.

Recommend (a): a small, explicit infra bundle plus the route's bundles.

### 5. Writes / invalidation

Current writes update the snapshot **in place** and also poke the raw cache
(`writeRaw` → `syncCache`, `settings.ts:348-355`). With the keyed cache the
write path becomes: write DB → `cache.set(key, value)` (decrypted) and
`setSnapshotField`, plus **bump the generation** so any concurrent in-flight
read is discarded. `invalidateCache` clears the `ttlCache` and resets the
snapshot to defaults (unchanged contract). No call-site changes for writers —
`settings.update.*` keeps its current surface.

## Migration sequence (incremental, always green)

1. **Land the cache + `loadKeys`** alongside the existing `loadAll`; refactor
   `buildSnapshot` into a per-key `resolveValues` / `applyToSnapshot` that
   `loadAll` reuses. No behaviour change yet (everything still
   `requiresAll`). Full test suite stays green.
2. **Add bundles + `withSettings` + dev assertion mode.** Undeclared routes use
   the temporary full-load bridge. Still no behaviour change.
3. **Migrate routes bundle-by-bundle**, starting with hot, narrow public routes
   (`GET /`, `GET /ticket/:slug`, embeds) where the win is largest and the
   surface is smallest. For each, declare bundles, run the dev assertion to
   confirm completeness, keep the suite green.
4. **Migrate the broad admin routes too** — give the admin settings page an
   explicit `adminSettingsPage` bundle (the union of the keys it reads). No
   route is left undeclared.
5. Once public routes are migrated, the common case loads a handful of keys
   instead of 130+, and adding a new large setting only costs the routes that
   actually declare it.

### 6. Remove `loadAll` (priority)

`loadAll` is the source of the waste this plan exists to fix, so its removal is
a first-class goal, not an afterthought. As soon as every route declares its
bundles (end of step 4), **delete `loadAll`, the full-load migration bridge,
and `buildSnapshot`'s whole-table path**. From then on the only way settings
reach the snapshot is `loadKeys` for declared bundles. The dev assertion mode
guarantees this is safe — any route that still reads an undeclared key fails its
test before the bridge is removed.

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
- **Should `loadAll` eventually be removed** once all routes declare bundles, or
  kept permanently as the `requiresAll` implementation? Recommend keeping it as
  the escape hatch.
</content>
</invoke>
