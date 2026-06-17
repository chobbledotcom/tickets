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

### 2. Bundles, the prefix table, and the dev assertion — ⏳ NEXT (Phase 2)

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

#### 2b. Declaring what a route needs: prefix baseline + handler top-ups

> This replaces the earlier "`withSettings` wrapper on each handler" sketch. The
> reason is the single-query investigation in §4: the exact matched handler is
> not known until deep inside lazy-loaded route modules, so reading per-handler
> metadata *before* the settings load would force every route module to be
> imported eagerly (killing cold-start) or duplicate all route patterns. A
> coarser, pure path→keys function avoids both. See §4 for the full reasoning.

Declaration happens at two levels, both cheap and both colocated:

1. **Prefix baseline (the pre-load).** A pure function keyed off the existing
   first-segment prefix (`getPrefix`, `index.ts:211`) returns the union bundle
   for that prefix. It does no imports and reads no settings, so it can run at
   the very top of the request, before anything is loaded:

   ```ts
   // src/features/route-settings.ts  (light module, eagerly imported by index.ts)
   import { TICKET_SETTINGS } from "./ticket/...";   // colocated const arrays
   import { ADMIN_BASELINE_SETTINGS } from "./admin/...";
   // ...
   const PREFIX_SETTINGS: Record<string, readonly string[]> = {
     "": HOME_SETTINGS,
     ticket: TICKET_SETTINGS,
     t: TICKET_VIEW_SETTINGS,
     listings: LISTINGS_SETTINGS,
     admin: ADMIN_BASELINE_SETTINGS,
     // ...one entry per prefixHandlers key
   };
   export const routeSettingsForPath = (path: string): readonly string[] =>
     PREFIX_SETTINGS[getPrefix(path)] ?? [];
   ```

   Only the **bundle constants** (plain `readonly string[]`) are imported
   eagerly — not the heavy handler modules — so cold-start is unaffected. The
   heavy route modules stay lazy.

2. **Handler top-ups (on-demand fine grain).** A handler that needs settings
   beyond its prefix baseline — typically a rare admin subpage that reads a big
   value like an email template, a wallet cert, or a provider secret — simply
   calls `await settings.loadKeys(STRIPE_SETTINGS)` at its top. Because
   `loadKeys` is incremental, this fetches only what the baseline didn't already
   cover, and is a no-op if it did. This keeps big values **out** of the common
   admin baseline while still being explicit and colocated with the code that
   reads them.

The net effect on query count (see §4): the common request — every public hot
path and most admin pages — loads in **one** query (infra ∪ prefix baseline).
Only a rare handler that genuinely needs extra big values issues a second,
targeted query, and only on that page.

A route that needs everything (the admin settings *page* itself, which reads
~40 settings to render the form) tops up with an explicit `ADMIN_SETTINGS_PAGE`
bundle — the union of every per-file bundle — rather than a magic "all" flag.

#### 2c. Dev assertion mode (the safety net)

This is what makes the coarse prefix baseline safe and lets us delete `loadAll`.
Wire a per-request "loaded key set" (the union actually passed to `loadKeys`
this request) and have `snap()` (`settings.ts`) record every snapshot key
actually read. In test/dev only (gated on an env flag or the existing test-mode
detection), at the end of a request assert that every key read was in the loaded
set; on a miss, throw an error naming the route, the offending key, and the
bundle it most likely belongs to. This catches both an under-declared prefix
baseline and a handler that forgot its top-up.

Mechanics:

- Add an internal `recordRead(key)` called from `snap()`; collect into a
  per-request set (an `AsyncLocalStorage`-style context already exists for flash
  / saved-form data — reuse that mechanism rather than a global).
- Track the loaded set as `loadKeys` is called (baseline + any top-ups), so the
  assertion compares reads ⊆ everything loaded, regardless of which mechanism
  loaded it.
- Map snapshot field names back to `CONFIG_KEYS` for the comparison (the special
  fields like `currency`/`timezone` map back to `COUNTRY`; `payment_provider`
  and `payment_provider_setting` map back to `PAYMENT_PROVIDER`).
- The assertion is **dev/test-only** — it must be a strict no-op in production
  (no per-read bookkeeping cost on the hot path beyond a cheap branch).

The payoff: every route exercised by the test suite is *proven* to load
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

#### The single-query question

Two queries per request (one for infra, one for the route bundle) is acceptable,
but **one is better**. This section is the investigation into whether one is
achievable, and the recommended design. Short answer: **yes, the common case is
one query**, by keying the pre-load off the path *prefix* rather than the exact
matched route.

**Why the exact route can't drive the pre-load.** The routing pipeline
(`src/features/index.ts`) is deliberately lazy to keep cold-start small:

- `routeMainApp` (`index.ts:372`) does O(1) dispatch on the first path segment
  via `getPrefix` (`index.ts:211`, pure — path string only) into
  `prefixHandlers` (`index.ts:319`).
- Almost every prefix entry is `lazyRoute(loadXRoutes)` — a dynamic `import()`
  of the feature's route module, which only then runs its own
  `createRouter`/`defineRoutes` matcher to find the handler.

So the *exact* handler (and any per-handler metadata) is only known **after**
lazy-loading that module and running its matcher. To drive the settings pre-load
off the exact route you would have to either (a) eagerly import every route
module up front to inspect handler metadata — which throws away the lazy-loading
that keeps the edge cold-start fast — or (b) duplicate every route's path
pattern in a second pre-dispatch matcher — drift-prone. Both are bad. This is
why §2b uses a *prefix*-keyed function instead of per-handler metadata.

**A second wrinkle: routing already reads settings.** Dispatch itself reads
`settings.showPublicApi` (`index.ts:333`) and `settings.showPublicSite`
(`index.ts:345`), and `handleRequestInternal` calls
`settings.setup.isComplete()` (`index.ts:402`). So settings must be populated
*before* dispatch — the pre-load can't be deferred until after a route matches.
Good news: **nothing reads the settings snapshot before
`prepareRequestEnvironment`** (verified — `routeStatic`,
`seedEffectiveDomainHost`, `initializeDatabaseForPath`, `trackingParamRedirect`
all run first and touch no settings), so the load point has full freedom to use
the path.

#### Recommended design: prefix baseline ∪ infra, in one query

Because `getPrefix(path)` is a pure function available at the very top of the
request, the prefix's bundle can be computed *before* the settings load and
unioned with the infra keys into a single `loadKeys`:

1. **Infra bundle.** `INFRA_SETTINGS` = the keys the pre-routing /
   dispatch pipeline itself touches: `CUSTOM_DOMAIN`,
   `CUSTOM_DOMAIN_LAST_VALIDATED` (domain resolution in
   `loadEffectiveDomain`), the five `LAST_PRUNED_*` keys (`maybeRunPrunes`),
   `SETUP_COMPLETE` (setup gate), and the two dispatch-gating flags
   `SHOW_PUBLIC_SITE` / `SHOW_PUBLIC_API`. All plaintext — no decryption.

2. **One load call.** In `prepareRequestEnvironment` (`index.ts:516`), replace
   `settings.loadAll()` with:

   ```ts
   await settings.loadKeys([
     ...INFRA_SETTINGS,
     ...routeSettingsForPath(path),   // prefix baseline, §2b
   ]);
   ```

   `routeSettingsForPath` is pure and import-free, so this is a single
   `WHERE key IN (…)` query covering infra + the whole prefix's needs. (Pass
   `path` into `prepareRequestEnvironment`; it currently only takes `request`.)

3. **Handler top-ups (rare second query).** A handler needing more than its
   prefix baseline calls `await settings.loadKeys(...)` itself (§2b). Only that
   page pays for a second query, and only for the keys the baseline missed.

4. **Migration bridge.** While a prefix has no entry in `PREFIX_SETTINGS`,
   `routeSettingsForPath` returns `[]` and we fall back to `settings.loadAll()`
   for that request. Removed in §6 once every prefix is mapped.

**Query-count outcome:** every public hot path (`/`, `/ticket/:slug`, `/t/…`,
`/listings`) and most admin pages → **one** query. A rare heavy admin subpage
(email templates, wallet certs, provider secrets) → two, by its own choice.

#### Granularity trade-off (prefix vs. exact route)

A prefix baseline is **coarser** than per-route: it loads the union of every
route under that prefix. This is always *correct* (a superset — the dev
assertion guarantees reads ⊆ loaded) and it's tight exactly where it matters,
because the hot public paths are each their own single-purpose prefix
(`ticket`, `t`, `listings`, `""`). The one prefix with many heterogeneous
sub-routes is `admin`. Two ways to keep admin lean, both supported:

- **Keep `ADMIN_BASELINE_SETTINGS` small** (auth, chrome, the few settings every
  admin page reads) and let heavy admin subpages top up (§2b.2). Recommended —
  one query for ordinary admin pages, big values loaded only where read.
- **If finer admin precision in a single query is ever wanted**, upgrade
  `routeSettingsForPath` to a small *pattern* table for the `admin` subtree only
  (a handful of regexes → bundles), accepting that those patterns duplicate the
  admin router's. Defer unless a specific high-traffic admin path justifies it.

#### Alternatives considered (and rejected)

- **Per-handler `withSettings` metadata read at dispatch.** Requires eager
  import of all route modules (loses lazy cold-start) or a full duplicate
  pattern matcher. Rejected — see "Why the exact route can't drive the
  pre-load" above.
- **Reorder the pipeline to match the route first, then load.** The matcher
  reads settings (`showPublicApi`/`showPublicSite`) and lazy-loads modules, so
  "match first" reintroduces the chicken-and-egg and the cold-start hit.
  Rejected.
- **Two unconditional queries (infra, then route).** Simplest, and explicitly
  fine per the user — but the prefix-baseline design gets the common case to one
  query for nearly the same complexity, so it's preferred.

#### Edge cases

- **Static assets / early returns** (`routeStatic`, `trackingParamRedirect`,
  `initializeDatabaseForPath`) run before `prepareRequestEnvironment` and read no
  settings — confirmed; no action.
- **404 / unknown prefix** — `routeSettingsForPath` returns `[]`; infra alone
  must render the not-found page. Verify the 404 renderer's reads are in infra,
  else add a tiny "layout" set (below).
- **Shared layout/chrome.** Most HTML pages render a header/footer reading
  website title, theme, header image. Rather than repeat those in every prefix
  bundle, fold a small `LAYOUT_SETTINGS` set into the union for any HTML route
  (or simply into the infra union, since it's a few small keys). Decide this
  explicitly in Phase 3 — it's the most likely source of assertion hits.

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
first-class deliverable, not cleanup. Once every prefix has a `PREFIX_SETTINGS`
entry and the dev assertion has run green across the full suite:

1. Delete the "empty prefix bundle → `loadAll()`" fallback in
   `prepareRequestEnvironment` (§4.4).
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
| 2 | Colocated bundle constants, `routeSettingsForPath` prefix table, dev assertion mode; empty-prefix fallback keeps behaviour identical (§2) | ⏳ next |
| 3 | Infra ∪ prefix-baseline single `loadKeys` in `prepareRequestEnvironment`; map the hot public prefixes (`""`, `ticket`, `t`, `listings`); resolve the layout-set question (§4) | ⏳ |
| 4 | Map remaining prefixes incl. `admin` (small baseline + handler top-ups; explicit `ADMIN_SETTINGS_PAGE` top-up for the settings page); make `getCachedRaw` consumers self-sufficient (§5) | ⏳ |
| 5 | Delete the empty-prefix fallback and `loadAll`; convert test `loadAll` calls (§6) | ⏳ |

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
2. **Declaration:** bundle *constants* colocated in the feature files that own
   the settings; composed into a pure, prefix-keyed `routeSettingsForPath`
   table (§2b) that drives the pre-load, plus on-demand `loadKeys` top-ups in
   handlers that need extra big values. (Supersedes the earlier per-handler
   `withSettings` idea — see §4 for why exact-route metadata can't drive a
   pre-load without losing lazy cold-start.)
3. **Fate of `loadAll`:** removed once every prefix is mapped (§6). It is a
   temporary migration fallback only — there is no permanent "load everything"
   mode, because that is exactly the waste being eliminated.
4. **Query count:** the common request (all public hot paths, most admin pages)
   loads in **one** query — infra ∪ prefix baseline. Only a rare handler that
   needs extra big values issues a second, targeted query. Two unconditional
   queries were considered acceptable but bettered by the prefix-baseline
   design.
