# Scheduled maintenance PR

This work is an independent prerequisite to durable payment sessions. It
provides secure, bounded, per-site maintenance infrastructure without changing
payment, refund, provider, or booking-completion behavior.

Build it from current `main`. Migrate only database-only maintenance present on
that branch. Later checkout and completion work consumes the task interface
without moving provider behavior into this PR.

## PR boundary

This PR includes:

- a protected local `POST /scheduled` endpoint on every site
- a unique scheduler secret for each site
- direct monitoring of each site with no builder fan-out
- one durable, atomic task-claim mechanism
- one declarative local maintenance registry
- migration of current pruning and activity-log backfill to that registry
- owner access to the site's key and host-operated provisioning
- generic time and subrequest budgets

This PR excludes:

- payment-session, checkout-stage, processed-payment, or charge schema changes
- payment-provider calls or provider-specific task costs
- checkout reconciliation or refund recovery
- durable booking-completion effects
- scheduler-key rotation or Uptime Kuma integration
- implementation of the external monitoring service

The later payment PR only registers new tasks with the shared registry.

## Current behavior

`GET /scheduled` and `POST /scheduled` are public. Any dynamic request also
queues interval-gated pruning. On a builder, POST claims one built site and sends
it an unauthenticated GET, so public traffic can cause database work and outbound
fan-out.

Current prune and activity-backfill markers use cached settings with a
read-then-write decision. Two isolates can both decide work is due and both run
it. Pending work is invocation-local and `Promise.allSettled` does not give the
monitor a meaningful task failure response.

`MAIN_INSTANCE_KEY` is unrelated and must not be reused. It authorises an
endpoint that can return full-access client database credentials.

## Endpoint contract

Use only:

`POST /scheduled`

Require:

`Authorization: Bearer <SCHEDULED_TASK_KEY>`

Responses are empty and include `Cache-Control: no-store`:

- 404 for every non-POST method
- 404 when `SCHEDULED_TASK_KEY` is unset
- 401 for a missing, malformed, or incorrect bearer value
- 204 after bounded local maintenance succeeds
- 503 for valid requests when setup, migration, boot, database, claimed task, or
  owned-release work fails

Do not return task counts, timings, provider details, site details, or error
text. The request cannot select a task, row, interval, batch size, or deadline.

Check access in the production request boundary before global boot checks,
Sentry setup, database initialization, settings loads, provider imports, or
request audit writes. Use one shared pure access helper and constant-time key
comparison. Direct unit tests exercise that helper; integration tests enter
through the real production handler rather than adding a second auth path.

Remove `/scheduled` from the normal application router. A direct internal app
handler therefore returns 404 rather than bypassing the production boundary.
The special path never buffers or reads a request body. Local process-start boot
validation may still prevent a broken development server from listening; it is
not request-triggered work.

`SCHEDULED_TASK_KEY` must be the canonical unpadded base64url encoding of exactly
32 bytes. Unset disables the endpoint; blank, malformed, or incorrectly sized
values fail boot validation.

## One maintenance registry

Define tasks as data rather than adding one scheduler function per feature. A
task declaration includes:

- stable name
- minimum interval of at least one minute
- hard task deadline
- maximum database calls
- maximum external calls
- enabled check and required settings keys
- bounded failure-retry interval
- `scheduled_only` or `organic_safe` wake policy
- a function receiving the remaining deadline and budget

The registry is static and exhaustive. A task function does not decide whether
it is due and does not write its own interval marker.

Initially register only:

- activity-log backfill at its current minute interval
- database pruning at its current daily interval

Remove their separate interval-claim implementations after migration. Keep
task-specific settings that control what pruning does, but not separate
last-run locks. Delete old `last_pruned_*` and activity-backfill marker rows,
registry declarations, preload keys, accessors, and debug rendering. If task
status remains useful, render `maintenance_tasks.last_finished_at` through one
shared diagnostic path.

The scheduled handler awaits the runner directly so a systemic failure reaches
the monitor. Disabled tasks are not inserted or claimed.

Organic fallback runs only `organic_safe` database-only tasks after a successful
safe idempotent foreground response is fully built. It excludes checkout,
payment, webhook, static, and health paths, starts no work concurrently with the
foreground route, uses zero external-call allowance, respects the measured
remaining whole-request budget, and uses a best-effort warm-isolate throttle.
The scheduled path does not queue a second run. Later provider and completion
tasks are `scheduled_only`.

## Durable task claims

Use a dedicated `maintenance_tasks` table rather than settings-cache markers:

- `name` primary key
- `next_run_at`
- `lease_token` and `lease_expires_at`
- `last_started_at` and `last_finished_at`

The schema requires lease token and expiry to be both present or both absent.
Task names come only from the static registry.

Claim one due task with one atomic write and `RETURNING`. A claim may win only
when `next_run_at <= now` and the old lease is absent or expired. The claim sets
only the new lease and `last_started_at`; it leaves the old due time unchanged.

On success, clear the owned lease, record completion, and set
`next_run_at = database_now + minimum_interval`. On failure, clear the owned
lease and set `next_run_at = database_now + failure_retry_interval`. Every
release is fenced by the lease token, and a zero-row release is a task failure.
A dead worker leaves the old due time in place and becomes immediately
reclaimable after lease expiry. An old worker cannot release a successor's
claim.

Order due tasks by absolute due time. A task that does not fit the remaining
request budget keeps its due time and becomes the oldest candidate next time.
One failing task must not stop unrelated tasks from becoming eligible, but the
authenticated endpoint reports a generic failure if any claimed task fails.
The runner attempts every due task that fits, then raises one aggregate failure.
The authenticated boundary converts it to empty 503. Organic fallback reports it
through normal server error reporting after preserving the already-built
foreground response; no task catches and suppresses its own error.

Use database time for claim comparisons where practical. The task lease must
outlive its task and request deadlines.

## Cadence

Set the registry's minimum task interval independently of the monitor. Later
work may use a one-minute task interval. A site owner may configure their monitor
to ping every one, five, or fifteen minutes.

The monitor interval affects only how soon quiet-site work wakes up:

- a one-minute monitor can claim every due minute
- a five- or fifteen-minute monitor claims on its next visit
- faster duplicate pings lose the durable claim
- no missed interval creates a catch-up burst

All cadences preserve correctness, but not throughput: a bounded one-minute task
can drain fifteen batches under one-minute pings and only one batch under a
fifteen-minute ping. Organic-safe tasks remain a fallback and race through the
same claim.

## Budgets and failures

Use one combined whole-request counter for database and external calls. Cap the
maintenance envelope at 40 total subrequests and reserve setup, claim, success or
failure release, and response headroom before claiming. Track database and
external allowances separately inside that total. Reject a task declaration
whose maximum cannot fit.

Stop claiming tasks before the request deadline. Pass an earlier deadline to
each task and preserve enough time for the final lease release. Deadlines are
cooperative unless every underlying operation supports cancellation. Never
release a lease while task code may still run. Do not hide a task exception
inside the task; the runner owns the recovery path and durable retry.

The generic scheduler does not know provider costs. The later payment task
declares one conservative maximum to the registry, then performs its own
provider-aware packing inside that allocation.

## Remove fleet fan-out

Delete builder-specific scheduler code, outbound safe-fetch calls, and GET side
effects. Builder and built sites run exactly the same local endpoint and task
registry. The external monitor calls every site directly and can report which
site failed.

Remove `claimNextBuiltSiteForPrune` and the now-dead `built_sites.last_pruned`
field with a normal schema migration. Keep its historical add migration in the
migration registry for old database chains.

## Per-site keys

Generate a unique key for each new built site beside its other unique native
secrets. Do not add it to the host-secret copy list, which would give every child
the same value. Split create, configure, and publish orchestration as needed so
the builder durably stores the generated key before the child becomes live. A
failed final builder write must not publish a child whose only key copy is lost.

Store the key only in:

- the child site's native `SCHEDULED_TASK_KEY` secret
- the builder's validated, versioned encrypted site-data blob

Use two separate displays. The child owner page reads its local native key on an
authenticated owner-only, no-store page so that owner can configure a monitor.
The builder owner page reads the encrypted value and owns host provisioning.
Never put the key in a URL, flash cookie, activity message, response log, or
system note.

Provide an explicit owner action to provision an existing site. Provider
secret-list APIs expose names, not values, so the encrypted parent copy is
required for builder display and retry. Treat a host secret name with no parent
value as an explicit replace/import conflict, never as proof of the unknown
value.

Do not build coordinated rotation here. The upcoming Uptime Kuma integration
will replace the monitor and site key together in one owner action. Until then,
a hosting operator can manually replace a compromised key and update the
monitor; a short maintenance-monitor outage during that emergency is acceptable.

Standalone sites set the native secret through their hosting operator. Their
owner page reads the configured value for monitor setup.

## Abuse controls

Authentication alone is not enough. Use all of these controls:

- reject invalid traffic before expensive application setup
- use 256-bit unique per-site secrets and constant-time comparison
- remove cross-site fan-out
- accept no caller-selected work
- atomically gate each task by interval across isolates
- use task leases, deadlines, and fixed budgets
- return no operational data
- do not write one database audit row per invalid attempt

A stolen valid key can still create edge invocations and cheap claim attempts.
The durable interval gate prevents repeated valid pings from becoming repeated
task work. Configure provider-specific edge rate limiting separately where the
host supports it; Deno and Bunny do not share one application control for this.

## Rollout

1. Deploy the builder/main code that can generate, store, show, and provision
   keys.
2. Provision unique keys on existing children while their old code harmlessly
   ignores the extra secret.
3. Register each monitor target in a paused state.
4. Deploy endpoint protection, GET removal, fan-out removal, task registry, and
   the dead-field migration together to each child.
5. Verify the new empty 204 contract, then enable that target.

A child without a key returns 404. Organic traffic still runs its local task
registry, so a missed provisioning step does not stop all maintenance.

## Acceptance tests

- Unset key and every non-POST method return 404 before boot or database work.
- Missing, malformed, and incorrect bearers return 401 with zero SQL and fetches.
- A valid POST returns an empty 204 and awaits the local runner; setup, boot,
  migration, DB, task, and release failures return empty 503.
- Builder and non-builder requests make no outbound scheduler fetch.
- Read-only mode permits a valid scheduled POST.
- The special boundary never reads a body and request data cannot select work.
- The normal app router cannot serve `/scheduled` directly.
- Boot validation requires one canonical 32-byte base64url key.
- Two new built sites receive different keys before publish.
- The key is absent from logs, URLs, flashes, notes, and plaintext site columns.
- Only an owner can view the current key or request host provisioning.
- A failed builder database write cannot publish a child and lose its only key.
- Failed provisioning retains one encrypted key and retries the same value.
- A missing task row claims once; an immediate second claim loses.
- Concurrent isolate claims produce exactly one winner.
- A fresh task lease cannot be stolen; an expired lease can be reclaimed.
- A stale token cannot release or finish its successor's task.
- Separate tasks claim independently and a failing task does not starve another.
- No routine task claim invalidates the broad settings cache.
- Organic fallback starts after the foreground result, runs only organic-safe DB
  tasks with zero external allowance, and races a scheduled POST to one claim.
- Checkout, payment, webhook, static, and health requests never start fallback.
- One-, five-, and fifteen-minute ping simulations remain correct and show their
  intentionally different bounded-batch throughput.
- Faster pings do not pull task due times forward or cause catch-up bursts.
- Exact call counters prove every task and whole request stay within budget.
- Current pruning remains daily and activity backfill remains minute-gated.
- A completed/disabled task is not claimed every minute.
- Historical backups before each removed marker and built-site column migration
  still restore through the latest schema.
- Old last-run setting declarations, rows, preload keys, accessors, and debug
  output have no production callers after migration.
- `built_sites.last_pruned`, public GET behavior, and builder fan-out have no
  production callers after migration.
