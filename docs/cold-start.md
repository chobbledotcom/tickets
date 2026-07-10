# Cold start: where the time goes, with benchmarks

A cold start is the first request an isolate serves after the edge runtime
spins it up: the runtime loads the 5.4MB bundle, runs its top-level code,
then the first request pays the one-off database housekeeping before the
route handler even runs. This document breaks that time down with two
reproducible benchmarks, and lists the improvements they point at, ranked
by measured impact.

Both benchmarks live in `scripts/bench/cold-start/` and run against the real
production build pipeline (same esbuild config, same asset inlining):

```bash
deno run -A scripts/bench/cold-start/bundle-load.ts     # CPU: parse + eval
deno run -A scripts/bench/cold-start/first-request.ts   # DB round trips
```

## The headline numbers

Measured on this container (Deno 2.5.6, fresh process per run, medians of 7;
edge hardware will differ in absolute terms but not in proportions):

| Phase | Cost | Scales with |
| --- | --- | --- |
| Runtime boot | ~10–35ms | — |
| Parse + compile the 5.4MB bundle | **~129ms** | bundle code size |
| Eager top-level evaluation | **~89ms** | number of eager modules (371 today) |
| First request: static route | ~3ms | — |
| First request: any dynamic route | **7 sequential DB round trips** before the handler runs | DB latency × 7 |
| Warm request | 1 round trip | DB latency × 1 |

With the database over the network (Turso from a Bunny PoP), the round-trip
chain dominates: at 50ms per round trip the first dynamic request takes
~375ms of pure waiting; at 100ms, ~730ms — on top of the ~220ms of CPU.

## Benchmark 1: loading the bundle (`bundle-load.ts`)

Builds the production bundle for `src/serve-app.ts` (the shared handler —
same contents as the edge bundle minus the BunnySDK wrapper), plus variants,
and times a fresh `deno run --no-code-cache` import of each:

```text
variant               size      import   first request
hello               0.00MB       1.2ms           0.8ms
full                5.42MB     217.7ms           3.4ms
lazy-entry          5.42MB     129.0ms          83.4ms
no-wasm             3.94MB     205.1ms               —
no-big-strings      3.76MB     206.2ms               —
```

- **`lazy-entry`** is the same bundle behind `await import()` — nothing
  evaluates until the first request. Its import time (~129ms) is the pure
  parse/compile share; the ~89ms difference is eager top-level evaluation,
  which it pays on the first request instead (83ms there).
- **`no-wasm` / `no-big-strings`** disprove the obvious theory: the 1.5MB of
  inlined base64 WASM and client-asset strings cost almost nothing to parse
  (~13ms and ~0ms). V8 handles giant string literals nearly for free — the
  parse cost is in the 3.7MB of actual minified *code*. Shrinking the bundle
  only helps cold start if it removes code, not strings.
- A warm V8 code cache halves the import (~113ms), but edge isolates can't
  be assumed to share one, so treat parse as a per-cold-start cost.

Where does the ~89ms of evaluation go? A V8 profile of the import shows it
spread across module initialisers, and a static-import walk explains why:
**371 of 833 `src/` modules evaluate eagerly** — the lazy route loaders in
`src/features/index.ts` are undermined by a handful of static import edges
that drag whole subsystems into boot:

| Eager edge | What it drags in |
| --- | --- |
| `features/middleware.ts` → `#routes/admin/scanner.ts` (for the `SCAN_API_PATTERN` constant) | admin scanner routes + templates + admin nav + builder + turso-api |
| `features/index.ts` → `#templates/public.tsx` (for `readOnlyPage`) | the whole public template barrel: markdown (`marked`), order-summary → checkout-pricing → payments, reservations → storage |
| `features/response.ts` → `#templates/payment.tsx` | layout.tsx → demo.ts → the band-name generator word lists |
| `features/auth.ts` → `features/csrf.ts` → `inbound-message` → `email` | email renderer (`liquidjs`) |
| `db/migrations.ts` → per-migration modules | most of `#shared/db/*` (139 modules) |

## Benchmark 2: the first request's database chain (`first-request.ts`)

Prepares a fully migrated, setup-complete database file, then spawns one
fresh process per simulated per-query latency. Every statement pays that
latency; the child serves `GET /` twice and records a query timeline:

```text
latency      first req   queries   second req   queries
0ms               26ms         7          2ms         1
25ms             203ms         7         28ms         1
50ms             375ms         7         52ms         1
100ms            761ms         7        102ms         1

Sequential round trips implied by the slope: ~7.4 cold, ~1.0 warm
```

The timeline at 100ms shows a perfect chain — every query waits for the
previous one:

```text
+   2ms  getDbState: SELECT ... WHERE key IN ('latest_db_update','db_schema_hash')
+ 105ms  CREATE TABLE IF NOT EXISTS schema_migrations ...
+ 207ms  SELECT id FROM schema_migrations
+ 308ms  SELECT value FROM settings WHERE key = ?   (script version marker)
+ 411ms  SELECT value FROM settings WHERE key = ?   (script commit marker)
+ 514ms  SELECT value FROM settings WHERE key = ?   (settings version probe)
+ 616ms  SELECT key, value FROM settings WHERE key IN (?, ...)  (settings load)
```

All seven run before the route handler sees the request. A warm request
needs only #6 (the settings version probe). Every one of these queries hits
the settings/migrations tables — none depends on the request.

## Improvement plan, ranked by measured impact

### 1. Collapse the cold-start query chain: 7 round trips → 2 (saves ~5 × DB latency)

The biggest production win by far — at 100ms latency this is ~500ms off
every cold start, and it's pure sequencing work, no behaviour change:

- **Skip the baseline check when the schema is already current** (queries
  2–3). `getDbState` has just proven `latest_db_update` and
  `db_schema_hash` both match the running build; `baselineCurrentSchemaIfNeeded`
  re-verifying `schema_migrations` on every isolate boot re-answers a
  question the schema hash already answered. Run it only when `getDbState`
  reports a mismatch (the migration path), or defer it to pending work.
- **Make `recordScriptVersion` fire-and-forget** (queries 4–5). It's
  explicitly best-effort bookkeeping ("a parent host can read it back") —
  it does not need to gate the first response. Schedule it via
  `addPendingWork` and merge its two single-key marker reads into one
  `WHERE key IN (...)` query.
- **Start the settings version probe alongside `initDb`, not after it**
  (query 6). Both are reads of the settings table; `prefetchVersion()` can
  be kicked off before `initDb` awaits, letting it overlap the state check
  instead of queueing behind it.

Floor after these: `getDbState` and the settings probe in parallel (1 round
trip of wall time), then the settings load (1 more) — matching the warm
request's shape plus one.

### 2. Fix the eager import edges: ~89ms of top-level evaluation (CPU)

The lazy route-loader design is right; a few static edges defeat it. Each
fix is a small module split, no logic change:

- Move `SCAN_API_PATTERN` out of `#routes/admin/scanner.ts` into a tiny
  constants module (or `features/middleware.ts` itself) so middleware stops
  pulling the admin scanner tree into boot.
- Import `readOnlyPage` in `features/index.ts` from its own module instead
  of the `#templates/public.tsx` barrel (or lazy-load it — it only renders
  in read-only mode).
- Split the payment templates out of `features/response.ts`'s eager path
  (they're only needed on payment routes, which are already lazy).
- Lazy-load the migration implementations in `db/migrations.ts`: the
  steady-state boot only needs `LATEST_UPDATE`/`SCHEMA_HASH` and the
  migration *ids*, not 139 db modules' worth of implementation.
- `features/auth.ts` → `csrf.ts` → `inbound-message.ts`: make the email
  sending import dynamic (it already is in several other modules).

Re-run `bundle-load.ts` after each fix; the "eager top-level eval" line
should fall toward the low tens of milliseconds. The eager-module count is
easy to keep honest in review: anything under `src/features/*` other than
`index.ts`/`middleware.ts`/`response.ts`-adjacent plumbing, and anything
under `src/ui/templates/*` other than the read-only/system pages, should
not be reachable by static import from `src/serve-app.ts`.

### 3. What *not* to bother with (measured dead ends)

- **Inlined WASM/asset strings**: ~13ms of the 218ms. Moving the codec WASM
  to remote storage would save bundle bytes (deploy-size headroom) but
  almost no cold-start time. Only worth it if the 10MB Bunny ceiling nears.
- **Bundle minification tweaks / dropping the source-map comment**: noise.
- **The parse share (~129ms)** only shrinks by shipping less code. The
  eager-edge fixes above don't help parse (lazy code still gets parsed), so
  treat major code-size reduction as a separate, lower-priority project —
  the per-ms payoff is far below fixes 1 and 2.

## Regression guardrails

- `scripts/bench/cold-start/` stays in the repo; both benchmarks print the
  numbers this document quotes and can be re-run before/after any change.
- The boot log now reads `App started (123ms)` — the isolate's real boot
  time (runtime start + bundle load), visible in production debug logs, so
  a cold-start regression shows up in observability rather than only in
  benchmarks.
