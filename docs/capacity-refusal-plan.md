# Capacity refusal diagnosis plan

Issue: chobbledotcom/tickets#2194. Review thread:
<https://github.com/chobbledotcom/tickets/pull/2127#discussion_r3842274321>.

Status: behaviour contract, revised after an adversarial review. A human must
approve this version before implementation starts.

## Current-system value

A capacity refusal whose lines only fail together names no listing, and a
12-line 90-day cart kills the paid checkout preflight with an SQL expression
error. This change makes the refusal name the first line that does not fit,
keeps large carts checkable, and makes a zero-quantity line mean the same thing
on every path.

## Production callers

| Entry point                   | Caller                               | Path                                                                  |
| ----------------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| `checkBatchAvailabilityImpl`  | public checkout preflight            | `src/features/public/ticket-payment.ts` `checkAvailability`           |
| `refusedOrderUnfitListingIds` | refused write diagnosis              | `src/shared/db/attendees/create.ts` `capacityFailure` (free and paid) |
| `buildCapacityCheckedInsert`  | every atomic create write            | `src/shared/db/attendees/create.ts`                                   |
| `capacityConditionFor`        | edit write guards and edit preflight | `src/shared/db/attendees/atomic-update.ts`                            |

The public checkout always books every dated line on one date and filters zero
quantities before the preflight (`ticket-form.ts` keeps `quantity > 0`).
Multi-date carts and zero-quantity lines therefore reach these paths only from
an operator's hand-built creation or edit.

## The one invariant

The guarded insert is a flat sequence of statements in one batch. Every insert
fires the aggregate trigger, so each statement's capacity clause sees every
earlier line through `booked_quantity`, whatever the line's date or listing
type, and sees earlier dated lines through their booking ranges. A read path
that predicts or explains the write must therefore answer, for each prefix of
the write order: does the demand of lines 1..k fit into the database state as it
was before the write? Today two read paths break that invariant, and one of them
can fail to run at all.

## Trusted facts

| Fact                                                     | Trusted              | Basis                                                                                                                                                                                                                       |
| -------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Line `listingId`, `quantity`, `date`, `durationDays`     | Yes after validation | Creators reject empty orders, negative quantities, and duplicate booking slots before writing; the diagnosis receives the same bookings the write guarded, in write order (`annotateOrderParents` maps 1:1 without sorting) |
| Listing rows (`max_attendees`, `listing_type`, `active`) | Yes                  | Read from the database at diagnosis time on the primary                                                                                                                                                                     |
| Group membership rows                                    | Yes                  | Read from the database at diagnosis time on the primary                                                                                                                                                                     |
| The stored capacity counting subqueries                  | Yes, shared          | The read clauses reuse the write predicate's counting subquery text, so both can never count differently                                                                                                                    |

A missing listing row is expected (the listing can be deleted between the write
and the diagnosis); the diagnosis returns no names in that case, as today. Every
other read error propagates.

## Zero-quantity contract (owner choice)

**Proposed rule: a line whose quantity is 0 demands no places and always fits.**
It contributes no demand to the preflight and the diagnosis, its write carries
no capacity or active condition, and it is never named as a culprit.

This is a policy flip, not only a bug fix. Today the write and the reads agree
on refusing a zero line on an inactive or full dated-daily listing, because the
same clause machinery runs on both sides. They diverge only for a date-less zero
line, where the write refuses and the preflight passes. The proposed rule makes
every path accept it.

For the flip: the pinned batch test already promises "treats a zero-quantity
item as a no-op that fits"; the no-quantity attendee is a real operator record;
a line that books nothing cannot make any capacity state worse, so asserting the
listing is bookable adds a failure mode with no protective value. The write
still enforces every order-level condition (modifier stock, ledger replay)
through the extra condition, and the row still writes, so the operator keeps the
record.

This choice needs human approval before implementation.

## Valid states

No stored state changes in this work; the paths are reads plus the existing
guarded writes. The inputs are:

- `LineBooking`: `listingId` (positive, existing), `quantity` (0 or more),
  `date` (null or YYYY-MM-DD), `durationDays` (1 to 90). Negative quantities are
  refused upstream and stay refused.
- One demand bucket per listing and per group, holding three components:
  - `perDay`: dated lines on per-date-cap listings (a listing bucket) or dated
    lines on any member (a group bucket), keyed by day;
  - `everyDay`: all lines on date-less-cap listings or members, dated or not,
    whose only capacity effect is the running total they bump;
  - `undatedOnly`: date-less lines on per-date-cap listings or members, which no
    dated statement can ever see.

## Commands and events

| Starting state                     | Command                                           | Required result                                                                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any cart                           | Checkout preflight (`checkBatchAvailabilityImpl`) | One boolean; refuses when any listing or group cap would be exceeded; never throws on a 12 x 90-day cart                                                                                                                    |
| Refused write                      | Diagnosis (`refusedOrderUnfitListingIds`)         | Exactly the first line in write order that does not fit on top of its predecessors, or `[]` when the whole order now fits or a listing is gone. Today's multi-date branch can name several listings; the set narrows to one |
| Zero-quantity line on any path     | Write, preflight, diagnosis, edit preflight       | No capacity or active condition applies; the row still writes; the line is never named                                                                                                                                      |
| Edit preflight (`unfitListingIds`) | Line changed to quantity 0                        | Fits, regardless of the listing's occupancy or active flag                                                                                                                                                                  |

## Failure table

| Work completed      | Failure                       | Required result                                                                | Retry owner                     |
| ------------------- | ----------------------------- | ------------------------------------------------------------------------------ | ------------------------------- |
| Nothing (diagnosis) | A listing row is missing      | Return `[]`, no names                                                          | None; the write already refused |
| Nothing (diagnosis) | Any other read error          | Propagate to the route's error handling                                        | Route                           |
| Preflight           | SQL expression depth exceeded | Cannot happen after this change: clause count stops depending on the day count | None                            |
| Write               | Guard aborts the batch        | Whole batch rolls back; diagnosis names a culprit                              | Existing behaviour, unchanged   |

## Retry and replay

The diagnosis is a read. It runs once per refused write and needs no stable
identity. Re-running it after more bookings land can name a different line; the
refusal reason stays authoritative and the naming is best effort for the message
the operator or buyer reads.

## Concurrency

| Operation A        | Operation B        | Required result                                 | Protection                                   |
| ------------------ | ------------------ | ----------------------------------------------- | -------------------------------------------- |
| Diagnosis read     | Concurrent booking | The named line may be stale; the refusal stands | Accepted; documented above                   |
| Two guarded writes | Same last place    | One wins, one rolls back and diagnoses          | Existing embedded capacity clause, unchanged |

## SQL shape

### The bug this fixes

`buildBatchCapacitySql` and the diagnosis probes emit one clause per
listing-day. Twelve daily lines at the 90-day maximum produce 1080 ANDed
clauses, past SQLite's 1000-node expression depth, so the paid checkout
preflight throws at checkout time.

### The new shape

One clause per listing and one per group. Each clause carries the bucket's
per-day demands as a `VALUES` table — referenced as `dayDemand.column1`,
`column2`, `column3`, because SQLite has no column-alias list on a table alias —
and refuses when any day violates the cap:

- Listing clause:
  `NOT EXISTS (SELECT 1 FROM (VALUES …) AS dayDemand
  WHERE (cap subquery) IS NULL OR (shared count subquery over
  dayDemand.column1/2 + dayDemand.column3 + everyDay) > (cap subquery))`.
  The `IS NULL` arm keeps an inactive listing refusing, as the write's clause
  does.
- Group clause: `NOT EXISTS (SELECT 1 FROM (VALUES …) AS dayDemand WHERE (cap
  subquery) > 0 AND (shared count subquery + dayDemand.column3
  - everyDay) > (cap subquery))`. The`> 0`gate is the write's`max_attendees >
    0`: an uncapped group never refuses.
- Undated clause, emitted beside the per-day clauses when the bucket holds any
  date-less demand: `(running-total basis) + whole bucket <= cap`, gated the
  same way. "Whole bucket" is the sum of all three components, because the
  trigger bumps `booked_quantity` for every insert, so the state the write's
  next undated statement sees is exactly the prefix's whole demand.

The counting subqueries keep their text; their day-range expressions widen from
branded bind tokens to plain SQL strings so they can reference `dayDemand`
columns. Clause depth stops depending on the day count: 12 daily lines at the
90-day maximum produce 12 listing clauses and a handful of group clauses. The
write predicate keeps its per-day AND chain (at most 90 days), which stays far
under the limit.

### The mixed-bucket fixes this shape brings

Today a bucket that holds both per-day and running-total demand drops the
undated side, and a group bucket folds its whole running-total demand into every
day's clause. Both diverge from the write: a daily listing booked with a dated
and a date-less line can be refused by the write with the read paths naming
nothing, and a date-less line on a per-date group member is counted against the
group's day caps although no dated statement of the write can ever see it. The
three-component bucket with the undated clause makes the read count exactly what
the write counts.

## The cumulative diagnosis

`refusedOrderUnfitListingIds` runs one cumulative prefix search over the write
order for every order, whatever its dates. This replaces both current branches:
the single-date prefix search (kept as the only path) and the multi-date
per-line check (deleted, it names nothing when same-date lines only fail
together).

The issue proposes grouping lines by date and searching within each date. A flat
search over the write order is strictly stronger and simpler: the guarded batch
is itself a flat sequential write, so a prefix of the write order is exactly the
demand the write had met when it refused. A per-date grouping would still name
nothing for two lines on different dates that share a running total and only
fail together, and it would need a second branch to merge per-date culprits into
write order.

Existing behavior kept: a whole-order probe first, so a race that freed the room
again names nothing; a missing listing names nothing; the probe count stays
logarithmic.

## Adversarial review record

A challenge pass found four breaks in the first draft, all folded into this
version: the `AS t(a,b)` VALUES alias does not parse in SQLite (use
`column1..3`); a shared `IS NULL` clause shape refuses every booking on an
uncapped group (the `> 0` gate is kept); a mixed listing bucket under-counts and
can name nothing (the undated clause with the whole bucket); and the group
`extra` fold counts a date-less line on a per-date member against the group's
days, where the write never sees it (the `everyDay` / `undatedOnly` split). The
flat prefix search itself held under attack: write order is preserved end to
end, and prefix fits are monotone, so the first unfit prefix is the statement
the write aborts on.

## PR shape

One vertical pull request. The three gaps are one invariant — the read paths and
the write path agree, and refusals name a culprit — and they land in the same
two files. Splitting the SQL rewrite from the diagnosis change would stack two
PRs over the same contract with no independent behavior between them.

The built modules: `src/shared/db/capacity-batch.ts` holds the cart read SQL
(`CapacityBucket`, `CartDemand`, `buildBatchCapacitySql`, `buildManyFitsSql`);
`src/shared/db/capacity.ts` keeps the write predicate and now exports the
counting subqueries (`buildListingCountSql`, `buildGroupCountSql`) the batch
clauses reuse; the diagnosis and the demand aggregation live in
`src/shared/db/attendees/capacity/checks.ts`. `capacity.ts` dropped from 425 to
292 lines, so no file sits over the 400-line target.

## Tests that prove the contract

1. A multi-date order whose same-date pair fails only together names the pair's
   second line (regression for the review thread's case).
2. A cross-date pair sharing a running total that only fails together names the
   second line.
3. A 12-listing, 90-day, same-date cart passes the checkout preflight without
   throwing.
4. A zero-quantity line on a full or inactive listing: preflight true, the
   guarded insert writes the row, the diagnosis names nothing, and the edit
   preflight passes.
5. A daily listing with one dated and one date-less line counts both demands:
   the write refuses it, and the diagnosis names the date-less line.
6. A date-less line on a per-date group member does not push the group's dated
   days over: the write accepts the cart, and the preflight accepts it too (the
   availability-consistency oracle pins this shape).
7. The SQL shape tests re-pin: one clause per bucket, `column1..3` references,
   the group `> 0` gate, and the undated clause beside per-day clauses.
8. The existing tests keep their results, including the two-call fitting budget
   and the logarithmic refusal budget; the test that names the deleted per-line
   mechanism is renamed to pin the flat search.

After the candidate is stable: `nix develop -c deno task precommit` and
`nix develop -c deno task precommit:mutation`.
