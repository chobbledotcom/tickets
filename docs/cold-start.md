# Cold start: where the time goes, with benchmarks

A cold start is the first request an isolate serves after the edge runtime
spins it up: the runtime loads the 5.4MB bundle, runs its top-level code,
then the first request pays the one-off database housekeeping before the
route handler even runs. This document breaks that time down with two
reproducible benchmarks, lists the improvements they pointed at, and — since
the two big ones are now implemented — records the before/after numbers for
each.

Both benchmarks live in `scripts/bench/cold-start/` and run against the real
production build pipeline (same esbuild config, same asset inlining):

```bash
deno run -A scripts/bench/cold-start/bundle-load.ts     # CPU: parse + eval
deno run -A scripts/bench/cold-start/first-request.ts   # DB round trips
```

## The headline numbers

Measured on this container (Deno 2.5.6, fresh process per run, medians of 7;
edge hardware will differ in absolute terms but not in proportions). "Before"
is the original investigation; "after" is the same benchmark on the fixed
code:

| Phase | Before | After | Scales with |
| --- | --- | --- | --- |
| Runtime boot | ~10–35ms | unchanged | — |
| Parse + compile the 5.4MB bundle | ~129ms | ~134ms (unchanged¹) | bundle code size |
| Eager top-level evaluation | **~89ms** (371 eager modules) | **~79–86ms** (297 eager modules) | number of eager modules |
| First request: static route | ~3ms | unchanged | — |
| First request: any dynamic route | **7 sequential DB round trips** | **2 sequential round trips** (4 queries, overlapped in pairs) | DB latency × sequential trips |
| Warm request | 1 round trip | unchanged | DB latency × 1 |

¹ Lazy code still gets parsed; only shipping less code shrinks this share.

The round-trip chain was the dominant cost and took the biggest cut: with
the database over the network (Turso from a Bunny PoP) at 100ms per round
trip, the first dynamic request went from **~730ms to ~229ms** of measured
wall time; at 50ms, from ~375ms to ~128ms.

## Benchmark 1: loading the bundle (`bundle-load.ts`)

Builds the production bundle for `src/serve-app.ts` (the shared handler —
same contents as the edge bundle minus the BunnySDK wrapper), plus variants,
and times a fresh `deno run --no-code-cache` import of each. Post-fix run:

```text
variant               size      import   first request
hello               0.00MB       1.1ms           0.7ms
full                5.42MB     220.6ms           3.6ms
lazy-entry          5.43MB     134.2ms          78.7ms
no-wasm             3.94MB     217.9ms               —
no-big-strings      3.08MB     173.4ms               —

Attribution (import medians):
  bundle load over baseline:        219.5ms
  ...of which eager top-level eval: 86.4ms (lazy-entry defers it to first request)
  ...of which WASM base64 parse:    2.7ms
  ...of which other big strings:    44.5ms
```

- **`lazy-entry`** is the same bundle behind `await import()` — nothing
  evaluates until the first request. Its import time (~134ms) is the pure
  parse/compile share; the difference from `full` is eager top-level
  evaluation, which it pays on the first request instead.
- **`no-wasm`** empties the 1.48MB of inlined base64 WASM: ~3ms. V8 parses
  plain base64 string literals nearly for free — shrinking those blobs is a
  deploy-size lever (the 10MB Bunny ceiling), not a cold-start one.
- **`no-big-strings`** is rebuilt through the real pipeline with the inlined
  client assets (built JS/CSS served from the bundle) emptied at build time.
  Unlike the base64, these ~0.9MB of escaped JS/CSS source strings do cost
  real parse time: ~45ms. Moving client assets out of the bundle (serving
  them from storage instead of inlining) is therefore a *modest* possible
  follow-up — but it trades away single-file deploys, so it only makes sense
  if the parse share matters after everything else.
- A warm V8 code cache halves the import, but edge isolates can't be assumed
  to share one, so treat parse as a per-cold-start cost.

### Eager evaluation: before ~89ms / 371 modules, after ~79–86ms / 297 modules

The original investigation found the lazy route loaders in
`src/features/index.ts` undermined by a handful of static import edges that
dragged whole subsystems into boot. Status of each:

| Eager edge | What it dragged in | Status |
| --- | --- | --- |
| `features/middleware.ts` → `#routes/admin/scanner.ts` (for `SCAN_API_PATTERN`) | admin scanner routes + templates + admin nav + builder + turso-api | **Fixed** — the pattern lives in `middleware.ts` itself |
| `features/index.ts` → `#templates/public.tsx` (for `readOnlyPage`) | the whole public template barrel: markdown (`marked`), order-summary → checkout-pricing → payments, reservations → storage | **Fixed** — imports `#templates/public/errors.tsx` directly |
| `features/response.ts` → `#templates/payment.tsx` | layout.tsx → demo.ts → the band-name generator word lists | **Fixed** — payment responses split into `features/payment-response.ts`, loaded only by the lazy payment routes; the demo *banner flag* split into `shared/demo-mode.ts` so layouts stop pulling the band-name word lists |
| `features/auth.ts` → `csrf.ts` → `inbound-message` → `email` | email renderer (`liquidjs`) | **Already lazy** — the suspect import turned out to be type-only, erased at build |
| `db/migrations.ts` → per-migration modules | most of `#shared/db/*` (~120 modules) | **Deferred** — see `TODO.md`; a registry split touching all ~70 migration files for a slice of the remaining ~80ms of CPU |

The remaining eager-module count is easy to keep honest in review: anything
under `src/features/*` other than `index.ts`/`middleware.ts`/`response.ts`-
adjacent plumbing, and anything under `src/ui/templates/*` other than the
read-only/system pages, should not be reachable by static import from
`src/serve-app.ts`.

## Benchmark 2: the first request's database chain (`first-request.ts`)

Prepares a fully migrated, setup-complete database file, then spawns one
fresh process per simulated per-query latency. Every statement pays that
latency; the child serves `GET /` twice and records a query timeline.

Original finding — a perfect chain of seven, every query waiting for the
previous one:

```text
latency      first req   queries   second req   queries
0ms               26ms         7          2ms         1
25ms             203ms         7         28ms         1
50ms             375ms         7         52ms         1
100ms            761ms         7        102ms         1

Sequential round trips implied by the slope: ~7.4 cold, ~1.0 warm

+   2ms  getDbState: SELECT ... WHERE key IN ('latest_db_update','db_schema_hash')
+ 105ms  CREATE TABLE IF NOT EXISTS schema_migrations ...
+ 207ms  SELECT id FROM schema_migrations
+ 308ms  SELECT value FROM settings WHERE key = ?   (script version marker)
+ 411ms  SELECT value FROM settings WHERE key = ?   (script commit marker)
+ 514ms  SELECT value FROM settings WHERE key = ?   (settings version probe)
+ 616ms  SELECT key, value FROM settings WHERE key IN (?, ...)  (settings load)
```

Post-fix, the same benchmark:

```text
latency      first req   queries   second req   queries
0ms               27ms         4          1ms         1
25ms              79ms         4         27ms         1
50ms             128ms         4         53ms         1
100ms            229ms         4        103ms         1

Sequential round trips implied by the slope: ~2.0 cold, ~1.0 warm

+   2ms  (102ms)  SELECT value FROM settings WHERE key = ?           (version probe)
+   3ms  (102ms)  SELECT key, value FROM settings WHERE key IN
                  ('latest_db_update', 'db_schema_hash', 'applied_migrations'…)  (schema probe)
+ 105ms  (101ms)  SELECT key, value FROM settings WHERE key IN (?, ?)  (script markers)
+ 106ms  (101ms)  SELECT key, value FROM settings WHERE key IN (?, …)  (settings load)
```

Four queries in two overlapped pairs — the floor predicted by the original
plan (the warm request's shape plus one). What changed:

- **The baseline check folded into the schema probe.** `probeDbState` asks
  "is the schema current?" *and* "is the migration history complete?" in one
  query (the markers plus a `UNION ALL … COUNT(*) FROM schema_migrations`),
  so the per-boot `CREATE TABLE IF NOT EXISTS` + `SELECT id` pair is gone
  while the self-healing behaviour (baselining a database whose
  `schema_migrations` is missing or incomplete) is preserved — now paid only
  when the probe says something is actually wrong.
- **`recordScriptVersion` no longer gates the response.** Its two single-key
  marker reads merged into one `WHERE key IN (?, ?)` read, and on the write
  path it runs as pending work after the response (fire-and-forget
  bookkeeping, as its contract states). Its steady-state read overlaps the
  settings load. The write path deliberately skips settings-cache
  invalidation (`executeBatchWithoutCacheInvalidation`) — the markers are
  not part of any snapshot, and invalidating mid-request would wipe the
  settings the page is being rendered from. One accepted caveat: Bunny kills
  fetches once the response is returned, so pending work flushes *before*
  responding — the single request per deploy per database that actually
  changes a marker still pays that write's round trip. That is a one-off
  per deploy, not part of the steady-state cold path measured above.
- **The settings version probe starts before `initDb`** (in
  `processRequest`, right after the request environment is seeded), so it
  overlaps the schema probe instead of queueing behind it.

## What *not* to bother with (measured dead ends)

- **Inlined WASM/base64**: ~3ms of parse. Moving the codec WASM to remote
  storage saves bundle bytes (deploy-size headroom) but essentially no
  cold-start time.
- **Bundle minification tweaks / dropping the source-map comment**: noise.
- **The parse share (~134ms)** only shrinks by shipping less code. The
  eager-edge fixes don't help parse (lazy code still gets parsed). The one
  measured lever is un-inlining the client assets (~45ms, see benchmark 1) —
  a separate project with a real architectural trade-off.

## Regression guardrails

- `scripts/bench/cold-start/` stays in the repo; both benchmarks print the
  numbers this document quotes and can be re-run before/after any change.
- `test/lib/cold-boot-queries.test.ts` locks the query chain: it simulates a
  cold isolate against a warm database, records every statement, and fails
  if the combined schema probe splits back apart, any boot write returns, or
  the total query count grows. A new boot query is a deliberate decision,
  not an accident.
- The boot log now reads `App started (123ms)` — the isolate's real boot
  time (runtime start + bundle load), visible in production debug logs, so
  a cold-start regression shows up in observability rather than only in
  benchmarks.
