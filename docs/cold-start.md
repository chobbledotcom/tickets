# Cold start: where the time goes, with benchmarks

A cold start = the runtime loads the 5.4MB bundle, runs its top-level code,
then the first request pays one-off database housekeeping before the handler
runs. Two reproducible benchmarks (real production build pipeline):

```bash
deno run -A scripts/bench/cold-start/bundle-load.ts     # CPU: parse + eval
deno run -A scripts/bench/cold-start/first-request.ts   # DB round trips
```

## Headline numbers (this container; proportions transfer to edge hardware)

| Phase | Before | After |
| --- | --- | --- |
| Parse + compile the 5.4MB bundle | ~129ms | ~134ms (unchanged¹) |
| Eager top-level evaluation | **~89ms** (371 eager modules) | **~79–86ms** (297) |
| First dynamic request | **7 sequential DB round trips** | **2** (4 queries, overlapped in pairs) |
| Warm request | 1 round trip | unchanged |

¹ Lazy code still gets parsed; only shipping less code shrinks this.

The round-trip chain dominated: at 100ms per round trip the first request
went from **~730ms to ~229ms**; at 50ms, from ~375ms to ~128ms.

## Benchmark 1: loading the bundle (`bundle-load.ts`)

```text
variant               size      import   first request
hello               0.00MB       1.1ms           0.7ms
full                5.42MB     220.6ms           3.6ms
lazy-entry          5.43MB     134.2ms          78.7ms
no-wasm             3.94MB     217.9ms               —
no-big-strings      3.08MB     173.4ms               —
```

- `lazy-entry` (same bundle behind `await import()`) isolates the pure
  parse/compile share; the difference from `full` is eager evaluation, paid
  on the first request instead.
- `no-wasm`: the 1.48MB of base64 WASM parses for ~3ms — shrinking it is a
  deploy-size lever, not a cold-start one.
- `no-big-strings`: the ~0.9MB of inlined client assets (escaped JS/CSS)
  cost ~45ms of parse. Un-inlining them would trade away single-file
  deploys — a possible follow-up, not done here.

### Eager import edges (before: 371 modules / after: 297)

| Edge | Status |
| --- | --- |
| `middleware.ts` → admin scanner (for one regex) | **Fixed** — pattern lives in middleware |
| `index.ts` → `#templates/public.tsx` barrel (for `readOnlyPage`) | **Fixed** — imports `public/errors.tsx` directly |
| `response.ts` → payment templates | **Fixed** — split into `payment-response.ts`, loaded only by lazy payment routes |
| `auth.ts` → csrf → email renderer | **Already lazy** (type-only import) |
| `db/migrations.ts` → ~70 migration modules | **Fixed** — second pass below |

Review guardrail: nothing under `src/features/*` (beyond the boot plumbing)
or `src/ui/templates/*` (beyond read-only/system pages) should be reachable
by static import from `src/serve-app.ts`.

### Eager import edges, second pass (312 → 189 modules)

Counted as `deno info` static-import reachability from `src/serve-app.ts`
(the first pass counted bundled modules; by this count its result was 312).

| Edge | Status |
| --- | --- |
| `auth.ts` → settings-nags → `superuser.ts` → `email.ts` (for one send) | **Fixed** — `sendEmail` loads on demand, so the every-request auth path stops dragging the email renderer, SVG tickets/QR, and the whole listings + accounting/ledger stack (~40 modules) |
| `db/migrations.ts` → 72 dated migration modules | **Fixed** — `migrations/registry.ts` holds `{ id, load }` pairs; the boot probe reads only ids, the implementations (and the domain modules they import, ~80 in total) load on the rare migration/fresh-install path. `test/shared/db/migration-registry.test.ts` locks registry ids to the loaded migrations |
| `db/migrations.ts` → 7 cache modules (for `clearAllCaches`) | **Fixed** — caches self-register with `cache-registry.ts` when their module loads; `clearAllCaches` sweeps the registry instead of importing every cache |

Measured effect (interleaved fresh-process medians on one container): full
bundle import ~239ms → ~234ms. The parse share is untouched (the lazy code
still ships), and the surviving eager evaluation is dominated by
`@libsql/client` and the settings/auth core the first request genuinely
needs — the app-code slice of eager eval is now close to its floor. The
durable win is structural: the migration implementations and the email stack
cannot silently re-enter the boot graph without failing the counts above.

## Benchmark 2: the first request's database chain (`first-request.ts`)

Before — a perfect chain of seven, each query waiting for the previous:

```text
latency   first req   queries        +   2ms  markers probe
0ms            26ms         7        + 105ms  CREATE TABLE schema_migrations
25ms          203ms         7        + 207ms  SELECT id FROM schema_migrations
50ms          375ms         7        + 308ms  script version marker read
100ms         761ms         7        + 411ms  script commit marker read
                                     + 514ms  settings version probe
~7.4 sequential round trips          + 616ms  settings load
```

After — four queries in two overlapped pairs (the warm shape plus one):

```text
latency   first req   queries        +   2ms  settings version probe   ┐ overlap
0ms            27ms         4        +   3ms  schema+history probe     ┘
25ms           79ms         4        + 105ms  script marker read       ┐ overlap
50ms          128ms         4        + 106ms  settings load            ┘
100ms         229ms         4
                                     ~2.0 sequential round trips
```

What changed:

- **The baseline check folded into the schema probe**: one query answers
  "schema current?" and "history complete?" (markers + `UNION ALL COUNT` of
  current migration ids), so the per-boot `CREATE TABLE` + `SELECT id` pair
  is gone; a restored database still self-heals, paid only when the probe
  finds something wrong.
- **`recordScriptVersion` no longer gates the response**: one merged marker
  read, run as pending work, writes skipping settings-cache invalidation
  (the markers live in no snapshot; invalidating mid-request would wipe the
  settings the page renders from). Caveat: pending work flushes *before*
  the response (Bunny kills later fetches), so the one deploy-changing
  request still pays its write.
- **The settings version probe starts before `initDb`** and overlaps the
  schema probe (skipped on setup paths; tracked-URL redirects answer before
  either and touch the database not at all).

## Measured dead ends

- Inlined WASM/base64: ~3ms of parse.
- Minification tweaks / source-map comment: noise.
- The parse share only shrinks by shipping less code; the one lever is
  un-inlining client assets (~45ms, trade-off above).

## Regression guardrails

- Both benchmarks stay in `scripts/bench/cold-start/` for before/after runs.
- `test/lib/cold-boot-queries.test.ts` locks the boot query chain — a new
  boot query fails the suite.
- The boot log reads `App started (123ms)`, so regressions show up in
  production debug logs.
