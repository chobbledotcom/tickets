# Column-aware cache invalidation for `listing_attendees` → `listings`

> Follow-up to #1308 (automatic, table-scoped cache invalidation at the
> db-client layer). Read that first — this plan assumes the registry and the
> `execute()` choke point it introduced.

## Problem

#1308 made cache invalidation automatic by inspecting each write statement's
**target table** and firing the invalidators registered against it
(`invalidateForSql` in `src/shared/db/client.ts`). The `listings` cache
declares a dependency on `listing_attendees` (in
`src/shared/db/listings.ts`, via the `dependsOn` argument to
`cachedEntityTable`) because DB triggers on `listing_attendees` maintain the
`listings` aggregate columns (`booked_quantity`, `tickets_count`, `income`).

That dependency is **table-granular**: _any_ write to `listing_attendees`
clears the listings cache. But the aggregate trigger is itself column-scoped —
`trg_listing_attendees_aggregates_update` is declared
`AFTER UPDATE OF quantity, price_paid, listing_id`
(`src/shared/db/migrations/schema.ts`, the `LISTING_AGGREGATE_TRIGGERS`
block). So the frequent per-booking column writes that do **not** touch those
columns now clear the listings cache for nothing:

- `markRefunded` / `updateCheckedIn` → `UPDATE listing_attendees SET refunded` /
  `SET checked_in` (`src/shared/db/attendees/update.ts`,
  `updateListingAttendeeField`)
- `incrementAttachmentDownloads` →
  `UPDATE listing_attendees SET attachment_downloads = …`
- `recomputeListingBookingRanges` →
  `UPDATE listing_attendees SET end_at = …`

None of these change a listing aggregate, yet each now forces the next
`getAllListings()` / `getListingWithCount()` to re-query and re-decrypt. Before
#1308 these paths invalidated nothing (correctly); #1308 documented this as a
deliberate safe-over-stale trade-off. This plan removes the over-invalidation
without reintroducing the manual-call fragility #1308 eliminated.

## Goal

A `listing_attendees` **UPDATE** should invalidate the listings cache only when
it writes one of the aggregate-affecting columns (`quantity`, `price_paid`,
`listing_id`). **INSERT** and **DELETE** always invalidate (a row entering or
leaving always shifts the aggregates — exactly what the insert/delete triggers
do). Same source of truth as the SQL triggers, expressed once.

Non-goals: column-awareness for any other cache (every other cache depends on
its own table, where any write is relevant); changing the triggers; changing
the public cache API.

## Why not just narrow the call sites

We could route the non-aggregate writes around invalidation (e.g. a flag on
`execute`). Rejected: it puts the "does this write matter to a cache" decision
back at the call site — the exact coupling #1308 removed. The knowledge of
_which columns feed the listings aggregates_ already lives in one place (the
trigger definition); the registry should mirror it, and the client should
derive the answer from the SQL it already inspects.

## Design

Extend the dependency declaration from "table" to "table, optionally gated on a
set of columns", and teach the client's statement inspector to extract the
columns an `UPDATE` assigns.

### 1. Registry: optional column gate (`src/shared/cache-registry.ts`)

Today: `registerTableInvalidation(tables: string[], invalidate)` and
`invalidateCachesForTable(table)`.

Change the registration to carry an optional predicate and the lookup to pass
what it knows about the statement:

```ts
type WriteInfo = {
  /** "insert" | "update" | "delete" | "replace" */
  verb: WriteVerb;
  /** Lower-cased columns assigned by an UPDATE … SET; empty for non-updates. */
  columns: ReadonlySet<string>;
};

// A dependency fires unconditionally unless it supplies `whenColumns`, in which
// case an UPDATE only fires it when it assigns at least one listed column
// (INSERT/DELETE/REPLACE always fire — rows enter/leave).
registerTableInvalidation(
  tables: readonly string[],
  invalidate: () => void,
  opts?: { whenColumns?: readonly string[] },
): void;

invalidateCachesForWrite(table: string, info: WriteInfo): void;
```

Backward compatible: callers that pass no `opts` behave exactly as today, so
`users`, `groups`, `holidays`, `logistics_agents` and the `listings`-own-table
dependency are unchanged.

`listings.ts` changes its `listing_attendees` dependency to:

```ts
// in cachedEntityTable(...) — listings declares two dependencies on the
// listing_attendees table: one column-gated for UPDATEs, and the implicit
// own-table "listings" dependency stays unconditional.
dependsOn: [
  { table: "listing_attendees", whenColumns: LISTING_AGGREGATE_WRITE_COLUMNS },
],
```

where `LISTING_AGGREGATE_WRITE_COLUMNS = ["quantity", "price_paid",
"listing_id"]` is exported from the schema module next to the trigger so the
two cannot drift (see §3).

> `cachedEntityTable` / `cachedTable` currently take `dependsOn: string[]`.
> Widen to `Array<string | { table: string; whenColumns?: string[] }>` and
> normalise. The own-table entry stays a bare string (unconditional).

### 2. Client: extract assigned columns (`src/shared/db/client.ts`)

`invalidateForSql` already matches the verb + table via `WRITE_TABLE_RE`.
Add a second, update-only parse of the `SET` assignment targets:

- Match `UPDATE <table> SET <assignments> [WHERE …]`.
- From `<assignments>`, take each `col = …` left-hand identifier up to the
  first top-level `=`, splitting on top-level commas (skip commas inside
  parentheses / string literals — the same lexing the code-quality call-site
  scanner already does in `test/lib/code-quality.test.ts` can be mirrored, but
  the SET clauses we emit are simple `col = ?` / `col = col + ?` forms, so a
  conservative parser is enough).
- Lower-case the names into a `Set`, build `WriteInfo`, call
  `invalidateCachesForWrite`.

All app-emitted `listing_attendees` UPDATEs are plain `SET col = ?` /
`SET col = col + 1` (see `update.ts`), so extraction is unambiguous. If parsing
ever fails to find columns on an UPDATE, **fall back to invalidating** (treat
unknown as "might matter") — preserves the #1308 safety direction.

### 3. Single source of truth for the column list

`LISTING_AGGREGATE_WRITE_COLUMNS` must equal the trigger's
`AFTER UPDATE OF …` list. Put the constant in the schema module that builds the
trigger SQL (`src/shared/db/migrations/schema.ts`) and interpolate it into the
`CREATE TRIGGER … AFTER UPDATE OF ${LISTING_AGGREGATE_WRITE_COLUMNS.join(", ")}`
string, so the trigger and the cache gate are generated from the same array.
A test asserts the trigger SQL contains exactly those columns.

## Test plan

New behavioural tests (extend
`test/lib/db/auto-cache-invalidation.test.ts`):

1. `markRefunded` / `updateCheckedIn` / `incrementAttachmentDownloads` do **not**
   invalidate the listings cache — warm the cache, perform the write, assert the
   same cached reference / unchanged fetch count (no re-query).
2. A `quantity` / `price_paid` UPDATE on `listing_attendees` **does** invalidate
   (booking edit via `atomic-update`, balance settle via `settleAttendeeBalance`)
   — already covered by the #1308 tests; keep them green.
3. INSERT (new booking) and DELETE (attendee removal) still invalidate.

Registry unit tests (extend `test/lib/request-cache.test.ts`):

4. A column-gated dependency fires for an UPDATE touching a listed column,
   does not fire for an UPDATE touching only other columns, and **always** fires
   for INSERT/DELETE/REPLACE.
5. Unknown/unparseable UPDATE columns fall back to firing.

SQL-parsing unit tests for the SET-column extractor: `SET a = ?`,
`SET a = a + 1, b = ?`, columns with table-qualified or quoted names, and a
`WHERE` clause containing `=` (must not be mistaken for an assignment).

Schema test (§3): trigger SQL and `LISTING_AGGREGATE_WRITE_COLUMNS` agree.

Plus the existing guard (no `getDb().execute` outside the client) and full
`deno task precommit`.

## Risks / trade-offs

- **Parsing fragility.** SET-clause parsing is more involved than the verb+table
  regex. Mitigated by: app-emitted UPDATEs are simple; conservative fallback to
  invalidate on any parse miss; dedicated parser unit tests. Net safety is never
  worse than #1308 (worst case = today's over-invalidation).
- **Two places encode column knowledge.** Eliminated by §3 (trigger and gate
  share one constant) + a test.
- **Marginal benefit scope.** Only the listings cache + `listing_attendees` pair
  benefits today. Worth it because those non-aggregate writes (check-in, refund,
  attachment downloads) are among the more frequent admin/agent actions, and a
  needless clear there evicts the whole listings set for every other concurrent
  request in the isolate.

## Estimated size

Small–medium: ~1 registry change, ~1 client parser + wiring, the listings
dependency declaration, the shared-constant refactor in the schema module, and
the tests above. No migration, no API change, no data change.
