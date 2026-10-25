# Cold start: measured separately, without pretending there is code splitting

Bunny and Deno Deploy receive one JavaScript file. A dynamic import in that file
can defer module evaluation, but it cannot avoid downloading or parsing the
file. Cold performance therefore has two different measured parts:

1. Load the production-shaped single-file bundle.
2. Serve the first real request, including database waits and lazy route work.

The benchmarks keep those parts separate because the deterministic request
benchmark uses a local SQLite database, while the production browser-platform
libsql bundle cannot open that file. Their numbers must not be presented as one
directly measured total.

```bash
deno run -A scripts/bench/cold-start/bundle-load.ts
deno run -A scripts/bench/cold-start/first-request.ts
```

Results below were measured on 14 July 2026 with Deno 2.5.6 in this development
container. Wall times depend on the machine. Bundle size, query count, and the
latency slope are the more durable comparisons.

## Single-file bundle load

`bundle-load.ts` builds the app core with the production edge build pipeline:
one minified ESM file, browser platform, no code splitting. It does not include
the thin `edge.ts` Bunny wrapper. It then runs each variant ten times in a fresh
Deno process with `--no-code-cache`. One discarded fresh-process run per variant
primes filesystem pages first. The balanced forward/reverse rotation puts each
variant in each run position twice and balances pair order. Attribution uses the
median difference between paired runs, not the difference between independent
medians.

```text
variant               size      import   first request
hello               0.00MB       1.0ms           0.8ms
full                5.51MB     156.2ms           2.6ms
lazy-entry          5.51MB     105.5ms          52.5ms
no-wasm             4.02MB     148.1ms               -
no-big-strings      3.16MB     139.1ms               -
```

The tiny hello file supplies the dynamic-import and path-resolution floor after
the benchmark child has started. It is not a process-start measurement.
`lazy-entry` puts the same app behind a dynamic import in the same file. It
estimates where work is paid, not code splitting: about 106 ms remains in file
loading and parsing, and the paired runs put about 51 ms of eager evaluation on
the first request instead. The full and lazy files are the same 5.51 MB.

The paired import differences put the app-core load above the tiny-file floor at
155 ms. Emptying the inlined WASM literals saves 8 ms, but that difference
includes JavaScript parsing, base64 decoding, allocation, and copying. It is not
a parse-only number. Emptying the other inlined large strings saves another 8
ms.

<details>
<summary>Raw bundle import samples and paired differences in milliseconds</summary>

```text
hello:          1.4 0.8 1.0 0.9 1.0 0.9 1.1 1.0 1.1 1.1
full:           160.4 154.3 153.7 158.7 153.4 151.4 155.6 160.6 217.9 156.9
lazy-entry:     105.6 103.2 105.0 107.5 103.4 105.3 111.8 105.5 115.3 106.4
no-wasm:        148.9 146.9 144.2 143.2 147.6 150.0 148.5 144.6 178.3 151.5
no-big-strings: 138.5 135.2 144.8 139.3 137.6 138.9 134.9 140.8 172.0 151.4
full - hello:   159.0 153.5 152.7 157.8 152.4 150.5 154.5 159.6 216.8 155.8
full - lazy:    54.8 51.1 48.6 51.2 50.1 46.1 43.8 55.1 102.6 50.6
full - no-wasm: 11.5 7.3 9.4 15.5 5.8 1.5 7.1 16.1 39.6 5.5
wasm - strings: 10.5 11.8 -0.5 3.9 10.1 11.0 13.6 3.8 6.3 0.1
```

</details>

The request in this benchmark is `/robots.txt`, which deliberately avoids the
database. This isolates boot checks and any app work deferred by `lazy-entry`.
It does not measure `/listings`.

The default benchmark is the self-contained build. A production build that
publishes shared browser assets to the optional CDN has a different file size.
The `no-big-strings` variant is an attribution experiment, not an exact CDN
artifact.

### Lean base request graph

Measured on 23 July 2026 against clean main `b51380cb`, with Deno 2.5.6 and
Sentry enabled. The comparison used production app-core bundles with the
benchmark's large publishable payloads emptied, then ran 60 balanced fresh
processes with `--no-code-cache`. The change keeps authentication, migrations,
Markdown, and storage available but stops generic static requests from
evaluating them before they are needed.

| Variant         | Bundle import | First `/robots.txt` |     Combined |
| --------------- | ------------: | ------------------: | -----------: |
| Main            |      235.9 ms |             13.0 ms |     250.9 ms |
| Lean base graph |  **181.9 ms** |         **10.8 ms** | **193.3 ms** |

The median paired combined improvement was **49.1 ms**. The middle half of
paired runs improved by 27.5–80.2 ms. The generated bundle grew by 723 bytes, so
this is evaluation deferral rather than a transfer-size win. The changes that
produced it are:

- import the shared session-key error without evaluating the authentication
  feature;
- load admin API authentication only after its path matches;
- load migration execution only for database-backed requests;
- keep the generic page layout independent of storage; and
- keep generic error pages independent of the broad public template and Markdown
  graph.

## Cold `/listings`

`first-request.ts` prepares a fully migrated, setup-complete public site with 12
regular groups, two packages, and one active listing in each. It stamps one-off
housekeeping before measurement. For each simulated latency it then starts eight
fresh child processes. The balanced forward/reverse rotation puts each of the
four latency levels in each run position twice and balances pair order. The
levels stop at 20 ms, the expected worst case for a replicated database.

Every child serves `/listings` twice. A valid sample must return status 200 and
contain every seeded group and listing name, so a partial page, redirect, or
error page cannot look fast. Every libsql execute or batch pays the configured
fake network latency and is counted as one round trip.

The baseline is `8d87b16f` (`origin/main` when measured). It was checked out in
a detached worktree, then only this branch's benchmark harness was applied to
it. The baseline and optimized code therefore ran the same fixture, validation,
balanced order, zero-delay behavior, and eight-sample summary. Both runs were
made in the same session in this container.

### Before and after

Cold request:

| Simulated latency | Before |      After | Round trips before | Round trips after |
| ----------------- | -----: | ---------: | -----------------: | ----------------: |
| 0 ms              |  86 ms |  **48 ms** |                119 |            **30** |
| 5 ms              | 167 ms | **114 ms** |                119 |            **30** |
| 10 ms             | 238 ms | **176 ms** |                119 |            **30** |
| 20 ms             | 378 ms | **297 ms** |                119 |            **30** |

Second request in the same process:

| Simulated latency | Before |      After | Round trips before | Round trips after |
| ----------------- | -----: | ---------: | -----------------: | ----------------: |
| 0 ms              |  24 ms |   **8 ms** |                114 |            **25** |
| 5 ms              |  97 ms |  **71 ms** |                114 |            **25** |
| 10 ms             | 154 ms | **121 ms** |                114 |            **25** |
| 20 ms             | 273 ms | **221 ms** |                114 |            **25** |

The median balanced-cycle four-point slope fell from about 14.9 to 12.1
sequential round trips cold, and from 12.4 to 10.5 warm. This proves the change
removed latency-critical stages rather than only collapsing calls that were
already parallel. At zero fake latency, the cold median fell by 38 ms (44%). At
20 ms, it fell by 81 ms (21%). Median absolute deviations were at most 9.1 ms
for the baseline cold samples and 2.3 ms for the optimized cold samples.

<details>
<summary>Raw cold / warm request samples in milliseconds</summary>

```text
baseline 0ms:  78.2/21.5 96.6/27.3 89.3/24.5 88.7/26.0 82.0/22.9 83.1/19.7 94.1/26.1 78.2/20.6
baseline 5ms:  203.5/97.5 177.3/98.1 185.1/94.7 166.0/98.9 159.8/92.2 158.3/95.7 162.3/88.9 167.5/102.8
baseline 10ms: 237.3/154.0 232.7/153.5 240.2/163.2 239.6/159.3 232.2/149.8 242.3/151.8 221.5/150.0 242.6/154.2
baseline 20ms: 379.8/272.9 367.9/274.3 404.4/278.3 377.0/274.0 372.3/272.4 460.0/270.4 386.1/273.8 356.5/272.3
after 0ms:     47.5/8.9 48.1/8.5 46.8/8.2 52.8/8.0 47.3/7.6 47.9/8.3 45.8/7.7 47.9/7.3
after 5ms:     114.9/69.1 113.7/69.1 116.0/72.0 113.8/71.1 113.3/68.2 115.8/70.4 114.0/71.0 245.1/103.4
after 10ms:    177.0/119.8 176.9/122.7 178.5/120.4 174.4/120.5 172.2/121.1 175.0/121.3 174.5/122.1 205.1/156.7
after 20ms:    295.3/221.9 301.2/220.1 296.0/221.3 297.5/221.2 298.9/222.2 294.3/221.0 300.1/219.3 293.6/221.6
```

</details>

### What was slow

The old group path repeated the full work for every regular group:

- Project and decrypt that group's listings.
- Read four parent/child relationship views.
- Read membership and capacity maps.

Each package separately repeated its member ids, prices, child relationships,
memberships, and capacity reads. With 14 groups, the page made 119 round trips.

### What changed

- One grouped projection loads all requested groups in one round trip and
  projects each shared listing only once.
- All regular groups share one discovery classification.
- All packages share one price read, one child-edge read, one membership map,
  and one capacity map. Each package still runs its own exact booking-tree limit
  over those shared facts.
- Package checks run at the same time as regular-group classification work.
- Group liveness no longer imports the 900-line payment-flow module just to use
  two loaders. In the one-file deploy this defers evaluation work; it does not
  reduce file parsing.

## Cold booking navigation

`first-request.ts` takes one argument, the scenario. The default scenario is
`listings`. The `booking-nav` scenario measures the booking page instead:

```bash
deno task bench:cold-start booking-nav
```

The scenario serves `GET /ticket/benchmark-listing-1`, the ticket page of the
benchmark listing. The listing sits on a site page, so the request builds the
public navigation model for a real target. The seeded nav tree carries a leaf
off the active chain. A sample is valid only when the page returns 200 with
every marker the scenario requires. The markers include the rendered active
chain: the Visit page's active link and the booked listing's active link. A
booking page that dropped its navigation cannot look fast.

The harness matches the listings scenario: eight fresh child processes per
simulated latency and the balanced forward and reverse rotation. The first
request in a fresh process is the cold sample. The second request in that
process is the warm sample. Every libsql call pays the configured fake latency
and counts one round trip. Production edge isolates live about 30 seconds. A
visitor therefore mostly hits the cold first request in a fresh process. The
warm second request is the best case.

### Recorded booking-nav results (PR #2621)

Measured on 20 October 2026 at pre-rebase head `9b1a68a51`. Every number is a
median of eight fresh processes per simulated latency. The source is the
bench-table comment on PR #2621, which names the job-submit run behind each
row.

| State | Cold @0ms | Cold @5ms | Cold @10ms | Cold @20ms | Cold round trips | Warm @20ms | Warm round trips |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A — main's nav code (baseline) | 61ms | 115ms | 162ms | 252ms | 16 | 154ms | 12 |
| B — nav-key change only | 67ms | 154ms | 225ms | 368ms | 23 | 241ms | 17 |
| C — chain-scoped leaf resolution | 63ms | 136ms | 197ms | 317ms | 20 | 197ms | 15 |

Warm requests at the other latencies (A / B / C): 4 / 5 / 4ms at 0ms,
47 / 75 / 61ms at 5ms, and 83 / 130 / 106ms at 10ms. The largest median
absolute deviation in any row was 3.1ms. The 51ms cold gap between states B
and C at 20ms therefore sat far outside run-to-run noise.

The nav-key change alone (state B) added 7 cold round trips over main
(16 to 23) and 116ms at 20ms. The chain-scoped consolidation (state C)
recovered 3 cold round trips and 51ms at 20ms. It also recovered 2 warm round
trips and 44ms. It did not return to main's 16 cold round trips: the booking
nav sat at 20. The listings scenario stayed unchanged through the same states,
with 23 cold round trips, 315ms at 20ms, and 14 warm round trips.

A re-observation at head `0bd0f650a` on 21 October 2026 measured the same 20
cold and 15 warm round trips. Its cold times sat a few ms above the recorded
run (325ms against 317ms at 20ms). That gap is run-to-run timing, not a query
change.

The limits section below applies to these numbers in full. They measured
source modules against a local SQLite file under fake latency, so they are not
an end-to-end production observation.

## What the request benchmark excludes

The request child statically imports `serve-app.ts` before its request clock. It
therefore includes route-triggered module evaluation, database work, rendering,
response encoding, and pending work, but excludes Deno startup and the eager app
module graph. It uses source modules and local SQLite so the database can be
wrapped deterministically.

Use `bundle-load.ts` for the one-file parse/evaluation measurement and
`first-request.ts` for request work and network-depth measurement. Do not add
their medians and call the result an end-to-end production observation.

## Regression guardrails

- `test/lib/server-public/listings-query-scaling.test.ts` proves total query
  count stays fixed as regular groups or packages are added. It also proves a
  listing shared by several groups is projected once before being mapped back to
  each group.
- Existing public listings, package, ticket, and site-page tests lock the
  rendered behavior and dead-link gates.
- `test/lib/cold-boot-queries.test.ts` continues to lock the four-query general
  boot chain before route business work.
- Production startup logs still report runtime/bundle load, request wait, boot
  setup, and Sentry separately.
