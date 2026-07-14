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
one minified ESM file, browser platform, no code splitting. It then runs each
variant seven times in a fresh Deno process with `--no-code-cache`. Variants are
interleaved so changing host load cannot favour one block of runs.

```text
variant               size      import   first request
hello               0.00MB       0.9ms           0.6ms
full                5.51MB     150.1ms           2.6ms
lazy-entry          5.51MB     102.1ms          52.1ms
no-wasm             4.02MB     143.5ms               -
no-big-strings      3.16MB     132.8ms               -
```

The tiny hello file supplies the process/import floor. `lazy-entry` puts the
same app behind a dynamic import in the same file. It estimates where work is
paid, not code splitting: about 102 ms remains in file loading and parsing, and
about 48 ms moves from import to the first request. The full and lazy files are
the same 5.51 MB.

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
housekeeping before measurement. For each simulated latency it then starts five
fresh child processes, interleaves the latency levels, and reports medians.

Every child serves `/listings` twice. A valid sample must return status 200 and
contain a seeded listing name, so a redirect or error page cannot look fast.
Every libsql execute or batch pays the configured fake network latency and is
counted as one round trip.

### Before and after

Cold request:

| Simulated latency | Before | After | Round trips before | Round trips after |
| --- | ---: | ---: | ---: | ---: |
| 0 ms | 59 ms | **42 ms** | 119 | **30** |
| 25 ms | 417 ms | **352 ms** | 119 | **30** |
| 50 ms | 771 ms | **654 ms** | 119 | **30** |
| 100 ms | 1,480 ms | **1,253 ms** | 119 | **30** |

Second request in the same process:

| Simulated latency | Before | After | Round trips before | Round trips after |
| --- | ---: | ---: | ---: | ---: |
| 0 ms | 16 ms | **7 ms** | 114 | **25** |
| 25 ms | 333 ms | **269 ms** | 114 | **25** |
| 50 ms | 630 ms | **521 ms** | 114 | **25** |
| 100 ms | 1,232 ms | **1,020 ms** | 114 | **25** |

The cold endpoint slope fell from about 14.2 to 12.1 sequential round trips.
The warm slope fell from about 12.2 to 10.1. This proves the change removed
latency-critical stages rather than only collapsing calls that were already
parallel. At zero fake latency, the cold median fell by 17 ms (29%). At 100 ms,
it fell by 227 ms (15%).

### What was slow

The old group path repeated the full work for every regular group:

- Project and decrypt that group's listings.
- Check hidden-package membership.
- Read four parent/child relationship views.
- Read membership and capacity maps.

Each package separately repeated its member ids, prices, child relationships,
memberships, and capacity reads. With 14 groups, the page made 119 round trips.

### What changed

- A joined group-member projection loads all requested groups in one round trip.
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

- `test/lib/server-public/listings-query-scaling.test.ts` proves several regular
  groups use one classification and several packages use one shared set of
  package reads.
- Existing public listings, package, ticket, and site-page tests lock the
  rendered behavior and dead-link gates.
- `test/lib/cold-boot-queries.test.ts` continues to lock the four-query general
  boot chain before route business work.
- Production startup logs still report runtime/bundle load, request wait, boot
  setup, and Sentry separately.
