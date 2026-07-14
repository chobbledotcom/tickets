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

## Cold `/listings`

`first-request.ts` prepares a fully migrated, setup-complete public site with 12
regular groups, two packages, and one active listing in each. It stamps one-off
housekeeping before measurement. For each simulated latency it then starts eight
fresh child processes. The balanced forward/reverse rotation puts each of the
four latency levels in each run position twice and balances pair order.

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

| Simulated latency | Before | After | Round trips before | Round trips after |
| --- | ---: | ---: | ---: | ---: |
| 0 ms | 62 ms | **43 ms** | 119 | **30** |
| 25 ms | 423 ms | **354 ms** | 119 | **30** |
| 50 ms | 770 ms | **655 ms** | 119 | **30** |
| 100 ms | 1,473 ms | **1,255 ms** | 119 | **30** |

Second request in the same process:

| Simulated latency | Before | After | Round trips before | Round trips after |
| --- | ---: | ---: | ---: | ---: |
| 0 ms | 17 ms | **7 ms** | 114 | **25** |
| 25 ms | 328 ms | **271 ms** | 114 | **25** |
| 50 ms | 627 ms | **521 ms** | 114 | **25** |
| 100 ms | 1,228 ms | **1,021 ms** | 114 | **25** |

The median balanced-cycle four-point slope fell from about 14.0 to 12.1
sequential round trips cold, and from 12.1 to 10.1 warm. This proves the change removed
latency-critical stages rather than only collapsing calls that were already
parallel. At zero fake latency, the cold median fell by 19 ms (30%). At 100 ms,
it fell by 218 ms (15%). Median absolute deviations were at most 3.2 ms for the
baseline cold samples and 1.6 ms for the optimized cold samples.

<details>
<summary>Raw cold / warm request samples in milliseconds</summary>

```text
baseline 0ms:   62.1/17.1 62.0/16.6 63.6/17.3 120.8/16.8 61.9/15.8 61.3/15.9 61.7/16.9 61.3/16.6
baseline 25ms:  423.0/326.4 426.0/324.4 422.7/328.3 419.7/327.8 422.6/325.8 417.6/329.8 424.8/329.2 419.9/328.4
baseline 50ms:  770.6/626.1 772.8/625.0 770.2/627.7 767.2/625.7 767.7/626.9 768.4/630.3 781.9/670.8 771.1/627.7
baseline 100ms: 1473.2/1227.1 1468.7/1227.8 1472.9/1228.2 1469.5/1226.5 1468.1/1224.6 1473.2/1227.9 1476.5/1227.7 1476.0/1229.7
after 0ms:      43.4/6.9 42.9/7.0 44.5/7.8 41.7/7.1 43.1/6.9 43.9/7.5 43.6/8.3 43.3/7.8
after 25ms:     357.2/271.8 353.7/269.1 353.6/270.1 351.1/269.5 354.0/271.0 355.6/273.6 354.9/271.6 355.0/271.6
after 50ms:     653.4/519.5 654.2/521.0 650.2/519.6 655.4/520.0 655.7/521.2 655.3/521.4 660.8/520.3 658.3/521.3
after 100ms:    1249.1/1021.1 1252.0/1020.2 1255.0/1021.0 1260.6/1020.4 1256.1/1019.9 1256.3/1021.6 1253.9/1022.0 1254.6/1020.8
```

</details>

### What was slow

The old group path repeated the full work for every regular group:

- Project and decrypt that group's listings.
- Check hidden-package membership.
- Read four parent/child relationship views.
- Read membership and capacity maps.

Each package separately repeated its member ids, prices, child relationships,
memberships, and capacity reads. With 14 groups, the page made 119 round trips.

### What changed

- One grouped projection loads all requested groups in one round trip and
  projects each shared listing only once.
- All regular groups share one hidden-member lookup and one discovery
  classification.
- All packages share one price read, one child-edge read, one membership map,
  and one capacity map. Each package still runs its own exact booking-tree limit
  over those shared facts.
- Package checks run at the same time as regular-group privacy and
  classification work, so batching does not add a serial wait.
- Group liveness no longer imports the 900-line payment-flow module just to use
  two loaders. In the one-file deploy this defers evaluation work; it does not
  reduce file parsing.

## What the request benchmark excludes

The request child statically imports `serve-app.ts` before its request clock.
It therefore includes route-triggered module evaluation, database work,
rendering, response encoding, and pending work, but excludes Deno startup and
the eager app module graph. It uses source modules and local SQLite so the
database can be wrapped deterministically.

Use `bundle-load.ts` for the one-file parse/evaluation measurement and
`first-request.ts` for request work and network-depth measurement. Do not add
their medians and call the result an end-to-end production observation.

## Regression guardrails

- `test/lib/server-public/listings-query-scaling.test.ts` proves total query
  count stays fixed as regular groups or packages are added. It also proves a
  listing shared by several groups is projected once before being mapped back
  to each group.
- Existing public listings, package, ticket, and site-page tests lock the
  rendered behavior and dead-link gates.
- `test/lib/cold-boot-queries.test.ts` continues to lock the four-query general
  boot chain before route business work.
- Production startup logs still report runtime/bundle load, request wait, boot
  setup, and Sentry separately.
