# TODO — remaining follow-ups

This file tracks work that was planned but **not yet done** when the root-level
planning/design docs were retired (they had served their purpose once the bulk
of each feature shipped). Each section is written to stand on its own — you
should not need the deleted docs to pick up an item. If you do want the full
original design, it is in git history:

```
git log --diff-filter=D --name-only -- '*.md'      # find the deletion commit
git show <deletion-commit>^:booking-unification.md  # read the old doc
```

The retired docs and their git-recoverable filenames: `parents.md`,
`editors.md`, `packages.md`, `listing-templates.md`, `tests.md`, `review.md`,
`settings-plan.md`, `pages.md`, `edit-pages.md`, `servicing.md`,
`TEST_QUALITY_IMPROVEMENTS.md`, `booking-unification.md`,
`booking-unification-phase2.md`. All were fully or substantially shipped;
everything still outstanding is captured below.

---

## Booking unification — phases 3 & 4

*Origin: `booking-unification.md`, `booking-unification-phase2.md`.*

**Background.** Bookings used to have three independently-grown models: a normal
listing, parent/child listings (`listing_parents`), and packages (`is_package`
groups, `group_listings`). The unification collapses all three into one
**booking-node tree** (`BookingTree`/`BookingNode`) where required / optional /
fixed / hidden items are just configurations of one structure, walked by five
generalized passes: render, fold, price, capacity, revalidate.

**Already shipped (phases 1 & 2, PR #1462) — do not redo:**
- Tree model + pure builder: `src/shared/booking/tree.ts`, `build-tree.ts`
  (`buildBookingTree`). The public renderer `src/ui/templates/public/
  reservations/` (entry point `ticket-page.tsx`) drives field names/rendering
  off the tree.
- Unified walks: `fold-tree.ts` (`foldBookingTree`), `price-tree.ts`
  (`effectivePrice`, `priceRuleByListingId`, `packageMemberPriceRule`),
  `capacity-tree.ts` (`packageQuantityCap`, own-cap + group-pool arms).
- `foldSelectedChildren` (`src/features/public/ticket-payment.ts`) is now a thin
  adapter over `foldBookingTree`. Pricing flows through `effectivePrice` in
  `ticket-payment.ts`, `ticket-submit.ts`, `api/index.ts`,
  `payment-processing.ts`, `webhook.ts`.
- v2 signed per-node metadata: `BookingItemSchema` (`src/shared/.../payments.ts`,
  ~line 67) is `{e,q,p}` plus optional edge tags `k` (`"p"`/`"g"`) and `r`
  (group id); `signed-metadata.ts` (`signedEdgeFor`); webhook re-walk in
  `payment-processing.ts` (`validateAllItems`, `packageBundleMismatch`,
  `classifySession`).
- A package member may itself be a parent: `isPackageableMember`
  (`src/shared/.../groups.ts`, ~line 115) now permits it.
- **Row-level admin identity + per-path bookings (multi-package orders).** The
  same listing id may now legitimately book through more than one path in a
  single order (a package member beside its own standalone row; the model also
  supports two overlapping packages). One `CheckoutItem`/booking row per path,
  each tagged `packageGroupId`; the booking-slot unique index and the
  merge/check-in row keys are widened with `package_group_id`
  (`2026-07-05_package_slot_identity` migration, `bookingKey`,
  `bookingSlotKey`). `PagePackage` + `buildBookingTree` build one node per
  path, and `/order` sells packages alongside listings via the pure
  `#shared/order` evaluator (`options.ts`/`evaluate.ts`). The admin attendee
  editor matches: one editable line per stored booking row (labelled with its
  path), plus blank per-(package, member) lines behind a pure-CSS toggle, so
  an operator can view, edit, and create every path combination a public
  buyer could — JS-free (`attendee-form-model.ts`, `attendee-page-data.ts`).

**Remaining:**

- **Phase 3 — unified edge store (optional; one-way door).** Collapse
  `listing_parents` and `group_listings` into a single edge table (or make one a
  view of the other). This is the only schema-migrating, hard-to-reverse phase,
  so only take it once a concrete need demands it. Shipping phases 1–2 and
  stopping here is an explicitly *successful* outcome, not a half-finished one.

- **Phase 4 — buyer-choice children inside a package (optional).** Let a package
  member offer a buyer-selected child (the parent/child choice UI, nested under a
  package). Build on demand when a real booking requires it.

- **`/order` live availability: fold required-child demand into options.** The
  order gallery's evaluator (`#shared/order`) judges an option by its direct
  listings' units; the children the booking form auto-folds under a parent (a
  sole bookable child fills to the parent quantity) are not part of the demand,
  so two selections contending for a shared child pool read as available on the
  gallery and are refused at the form. Advisory-only today (the form is the
  authority — documented in `src/features/public/order.ts`); fixing it means
  loading each option's children in `loadOrderCatalog` and adding the
  guaranteed folded units (and their group pools) to `unitsByListingId`.

- **Per-path sale amounts in the ledger projection.** A booking posts ONE
  `sale` leg per listing (`bookingFactsFromOrder` sums the order's lines by
  listing id; the leg reference is `["sale", listingId]`), and
  `pricePaidFromLedger` splits that total across the listing's sibling rows in
  quantity proportion. When one listing books through two paths at DIFFERENT
  prices in one order (package override beside its own standalone row), the
  per-row `price_paid` readback is therefore quantity-averaged — e.g. 4×400
  package units + 1×500 standalone reads back 1680/420 instead of 1600/500.
  Order totals, revenue sums, and refunds are exact (the shares telescope);
  only per-row display/merge granularity blurs, and only when per-path prices
  differ. Fixing it needs a SQL-queryable per-path discriminator on sale legs
  (a transfers schema addition — `reference` is a hash, `kind`/`dest_id` feed
  reports) or re-storing the per-row amount, plus a fallback for pre-upgrade
  rows whose legs are untagged. Do it when per-row money display matters more
  than the schema stability of the append-only ledger.

- **Confirm the v1 drain bridge is genuinely unnecessary.** The original plan
  called for a bounded-window read-only parser for pre-cutover (v1) signed
  metadata plus a regression test for an old-shape session paid during the
  cutover window. No dedicated bridge was built. In practice the v2 schema added
  `k`/`r` as *optional* fields to the existing `e/q/p` line shape, so old
  sessions still parse (as standalone lines). Verify this covers every
  in-flight-session case and, if so, close this out; otherwise add the bridge +
  drain-window test.

---

## Entity pages migration — slices 2–5

*Origin: `edit-pages.md`.*

**Background.** "Entity pages" is one declarative, schema-driven, tabbed
framework (`defineEntityPage`) that replaces every hand-assembled admin "edit X"
page. A page becomes data: tabs of typed sections (summary / form / ledger /
activity / notes / actions / custom) rendered through an exhaustive `Record`,
with per-tab authorization, path-segment tabs, and in-place 400-error re-render.
Migration is deliberately gradual and hardest-first.

**Already shipped (slice 1, PRs #1500, #1502, #1503) — do not redo:**
- Framework: `src/shared/entity-pages/core.ts`, `src/features/admin/
  entity-pages.ts`, `src/ui/templates/admin/entity-pages.tsx`.
- Attendees fully migrated onto it: `src/features/admin/attendee-page.ts`
  (the only current caller of `defineEntityPage`); legacy attendee action URLs
  removed; tabs left-aligned, section-panel grouping added.

**Remaining slices (each is roughly one PR; keep them small):**

- **Slice 2 — Listings.** Collapse the separate listing detail + edit pages into
  one entity page. `src/features/admin/listings*.ts` and
  `src/ui/templates/admin/listings.tsx` do NOT yet use `defineEntityPage`. This
  is the second copy of the tab/section composition, so it's the natural next
  proof after attendees.
- **Slice 3 — Modifiers.** The third copy of the composition
  (`src/features/admin/modifiers.ts`). Migrating it validates the framework
  generalizes.
- **Slice 4 — the long tail.** Groups, users, questions, built-sites,
  attendee-statuses, holidays, and `history/:hmac` — one small PR each.
- **Slice 5 — generalize `system_notes`** from attendee-only to
  `(entity_type, entity_id)` so any entity page can carry a notes section. The
  notes DB module currently has no `entity_type` column; this is a small
  migration + query change that unblocks notes tabs on the other entities.

---

## Servicing — read-only guard (optional variant)

*Origin: `servicing.md` (+ its review docs `review.md`, `tests.md`).*

**Background.** The servicing-events feature (attendee-kind rows that hold
listing capacity without being customers) shipped and was hardened across PRs
#1395, #1499, #1501: all P0/P1/P2 review defects fixed, a unified currency-aware
money schema introduced at `src/shared/validation/money.ts`
(`parsePositiveMinorUnits` / `validatePrice`), and the read-only default-deny
guard added (path-based allowlist, fails closed). The last money site — the
modifier `calc_value` / `min_subtotal` fields — was then made currency-aware:
`min_subtotal` through the shared `parseOptionalMinorUnits`, and the polymorphic
fixed `calc_value` through a `calc_kind`-aware `exceedsCurrencyPrecision` guard
in `validateModifier` (so a percentage or multiplier keeps its precision).

**Remaining (optional):**

- **Registry-driven read-only default-deny.** The current path-based allowlist
  already fails closed. The fuller variant — resolve the route first, then
  consult a per-route `readOnly: "allow"` flag — is an optional future refactor,
  not a fix.

---

## Test quality

*Origin: `TEST_QUALITY_IMPROVEMENTS.md`.*

**Background.** The goal is to move past coverage-as-floor toward proving
*assertion strength*. The priority-1 initiative — **mutation testing as a gate**
— is fully shipped: `scripts/mutation.ts` + `scripts/mutation/`, `deno task
mutation` and `precommit:mutation` (staged-file gate, batched to bound file
descriptors — PRs #1478 and others). A weak-assertion audit script also exists:
`scripts/test-quality-audit.ts`.

**Remaining:**

- **Mutation tests removed from `deno task precommit`.** The
  `precommit:mutation` step was too slow for the standard precommit run and was
  removed from `scripts/precommit/steps.ts`. The mutation gate still exists as
  `deno task precommit:mutation` and `deno task mutation` — run it manually on
  changed src/test pairs before merging. Re-wire it into precommit (perhaps
  behind a flag or with a tighter changed-set bound) only if the per-commit
  mutation cost comes down.

- **Property-based tests (item 5).** `fast-check` is currently used in only one
  test (`test/lib/fold-tree.test.ts`). Add properties for: slug generation, CSV
  round-trips (commas / quotes / CRLF), date formatting across timezones, token
  parsers, and URL safety.
- **Weak-assertion audit lifecycle (item 6).** The script exists but isn't wired
  into CI. Escalate it: informational → CI warning → review gate for touched
  files.
- **Production-shape checks (item 7).** Stand up a scheduled or release-blocking
  suite distinct from the unit run: edge-bundle smoke test, backup/restore
  drills, concurrent-reservation race, webhook replay/idempotency, load tests,
  security scans.
- **Ongoing ratchets (items 2 & 3).** In new/touched files, keep replacing
  compound-boolean assertions with specific ones and strengthening bare presence
  checks. These are permanent review habits, not a one-time sweep.
- **Metrics.** Surface mutation-score baselines / surviving-mutant counts as a
  tracked artifact so regressions in assertion strength are visible.

---

## Settings on-demand loading — generation counter

*Origin: `settings-plan.md`.*

**Background.** The eager `settings.loadAll()` (decrypt every settings row on
every request) was replaced by keyed, on-demand loading:
`prepareRequestEnvironment` calls `settings.loadKeys(settingsForPath(path))`,
per-route bundles live in `PREFIX_SETTINGS`, `loadAll` is deleted, and a
dev-mode read-audit (`src/shared/db/settings-audit.ts`, wired into `snap()`)
keeps the bundles honest by failing when a route reads a key it didn't declare.

**Remaining (deferred by design):**

- **Generation counter for concurrent partial-load/write races.** Only add this
  if profiling shows real concurrency between a partial load and a settings
  write. Not needed today.

---

## Packages / choice slots (parent members with a pick count)

- **Chooser own-cap footgun.** A choice slot is a package member that is a
  parent listing; its own `max_quantity` feeds the bundle cap
  (`min(own_cap, child_units) ÷ pick_count`). A chooser left at the default
  `max_quantity: 1` under a pick-2 slot silently caps the whole package at 0,
  with no save-time warning. Fix: reject (or warn on) a parent package member
  whose per-order cap is below its pick count.

- **Capacity edge cases beyond the shipped model.** The shipped bundle-cap model
  (per-member child caps, sole-child pools, all-children forced demand) covers
  the common configurations but is not a full per-candidate feasibility solver:
  partial-overlap cases stay approximate — pool-subset unions (e.g. three pick-1
  slots over two 1-spot pools), a multi-pool candidate double-counted as
  alternative supply, and jointly-infeasible cross-slot mixes. All fail SAFE (the
  atomic submit write rejects; capacity is never clamped, only rejected), so the
  cost is a rare dead-end submit or an over-advertised bundle, never overbooking.
  Revisit only if a real configuration hits it.

- **Deferred choice-slot semantics.** Optional slots (a min/max pick count, e.g.
  "choose 0–2"); a per-slot "distinct picks" flag; per-package-unit pick mixes
  (today N packages × pick-K allows any mix of N×K picks, following the
  parent-quantity distribution); and a group-edit "add choice slot" affordance
  that mints the chooser listing plus its child edges in one step with sensible
  default caps.

## Listings offered under multiple parents / "can be booked by itself"

- No outstanding items — the row-identity fix (per-parent attendee rows, paid
  mapping by listing id, remainder rows) and the `bookable_alone` flag shipped.

## Public nav / group liveness

- **Batch package bundle-cap evaluation across group leaves.** A site page's
  group nav links now load their members in one batch
  (`getVisibleGroupMembersByGroupIds`), but each PACKAGE group still evaluates its
  own whole-bundle cap independently in `packageGroupBookable` (membership,
  per-member capacity, prices, booking tree), and each regular group runs its own
  `classifyForDiscovery`. So a page with many group links still issues O(groups)
  liveness reads beyond the shared member batch. Fully batching would mean
  computing bundle caps for several packages in one pass over shared capacity
  maps — worthwhile only if a page with many package links shows up hot.

## Test-suite speed — remaining opportunities

*Origin: the test-suite performance pass (lazy Sentry, fast `toContain`,
migration-suite sharding, `withVirtualBackoff`, `cachedAdminPage`; see the
Fast Tests section of AGENTS.md). These were identified during profiling but
deliberately left for later:*

- **Per-file module-graph evaluation.** Every test file re-evaluates the app's
  module graph (~0.35s each after the lazy-Sentry fix, ~250 files ≈ 80-90s of
  CPU per run). The biggest remaining import-time chunks are `@libsql/client`
  (~65ms, needed) and the `#routes` feature tree (~150ms). Any further
  import-time work moved behind `once()`/dynamic import pays for itself ~250×
  per run — profile with a `performance.now()` probe around `import("#test-utils")`
  under `deno test` before and after.
- **`test/lib/stripe-mock/ports.test.ts` (~4s)** spawns real child processes
  to test the harness's port handling; each spawn is inherently slow. If it
  grows, the port-conflict cases could stub the child-process layer the same
  way the supervisor tests do.

---

## Capacity rules — feature-layer adoption (stage 3)

*Origin: the capacity-rules consolidation (`src/shared/capacity-rules.ts`).*
Stages 1–2 shipped: the declarative `CAPACITY_RULES` table exists, and the SQL
guard (`src/shared/db/capacity.ts`), the JS preflight
(`src/shared/db/attendees/capacity.ts`, `update.ts`), and the booking-page
limits (`booking/model.ts`, `booking/package-cap.ts`) all derive their
per-date-vs-running-total decisions from it. Stage 3 shipped too: the
feature-layer capacity-date call sites (`ticket-payment.ts` `bookingDateFields`,
`qr-book.ts` `buildCheckoutIntent`, `api/listings.ts` child availability,
`api/booking.ts` `resolveBookingDate`) consult
`capacityDateFor`/`countsPerDate` instead of branching on
`listing_type === "daily"` by hand. Only the *capacity-date* decisions belong
to the table — the remaining calendar/UI daily branches (date pickers,
sorting, display, duration spans) are date-selection logic and should stay as
they are. Nothing further planned here.

---

## Strengthen the idempotent-replay assertion in the payments confirmation test

*Origin: CodeRabbit review on PR #1690 (payments test split).*

`test/lib/server-payments/confirm.test.ts`, the test **"handles replay of same
session (idempotent)"**, asserts `expect([200, 302]).toContain(response.status)`.
This hedge was moved verbatim from the old `server-payments.test.ts` monolith —
it accepts either branch, so it would not catch a regression that flips the
replay from one path to the other.

Pinning it to a single deterministic status is a real behavioural question, not
a mechanical edit: the test books an attendee directly (payment intent
`pi_test_123`) and then replays the same signed session, and the current code
does **not** dedupe on payment-intent (the in-test comment spells this out), so
the outcome depends on the capacity check rather than a defined idempotency
contract. Deciding the single correct status means first deciding what replaying
an already-booked payment intent *should* do (reject as duplicate? re-render the
existing ticket?) and likely adding payment-intent uniqueness — out of scope for
a test-only file split. Starting point: `src/features/api/payment-processing.ts`
(the `/payment/success` finalize path) and `#shared/db/processed-payments.ts`.

## Payment-processing review follow-ups (from PR #1692)

Both items describe behaviour that predates the payment-processing split (the
code was moved verbatim from the old `payment-processing.ts` monolith). They are
recorded here because the split PR was a pure reorganisation — changing this
behaviour there would be out of scope — and CodeRabbit flagged them as worth a
look.

- **Refund after a committed booking** (`src/features/api/payment-processing/index.ts`,
  the `try { honoured = await createAttendeeForSession(...) } catch` in
  `processReservedSession`). `createAttendeeForSession` commits the attendee +
  bookings atomically, then runs `ensureAllBookings` (a post-commit read). If
  that post-write step *threw*, the `catch` would route to `storeRefundedBooking`
  — refunding a booking that actually persisted. Today `ensureAllBookings`
  returns a structured `{ ok: false }` rather than throwing on the capacity path,
  so the window is theoretical, but it isn't guarded structurally. Fix direction:
  narrow the `try` to the pre-commit call only, or guarantee the post-commit
  cleanup path is non-throwing, so a persisted booking can never be refunded.
  Add a regression test that makes the post-commit step throw and asserts no
  refund is issued.
- **Per-item DB reads not batched** (`src/features/api/payment-processing/items.ts`
  `validateAllItems`, and `package-pricing.ts` `loadPackagePricingByGroup`).
  `validateAllItems` calls `getListingWithCount` once per item in a loop, and
  `loadPackagePricingByGroup` makes two sequential round-trips per group. Under
  the edge subrequest budget these accumulate for larger orders. Fix direction:
  add/use a batched `getListingsWithCount(ids)` for all order listing ids at once
  and group the package-pricing loads, preserving the existing validation and
  fail-closed behaviour. See the "Respect the subrequest budget" guidance in
  AGENTS.md.

## Cold start: lazy-load the migration implementations (from PR #1714)

*Origin: `docs/cold-start.md`.* `src/shared/db/migrations.ts` statically
imports every per-migration module (~70 files) — the bulk of the remaining
~120 eager `#shared/db/*` modules. A steady-state boot only needs each
migration's *id* plus `LATEST_UPDATE`/`SCHEMA_HASH`; the fix is a registry of
`{ id, load: () => import(...) }` pairs awaited only on the migration path.
Deferred: it touches every migration module and `runMigrations`' control flow
(see the load-bearing baseline test in `test/shared/db/migrations.test.ts`)
for a slice of ~80ms of CPU. Re-measure with
`scripts/bench/cold-start/bundle-load.ts` before and after.

## Cross-request pending work vs. restore (from PR #1714)

PR #1714 makes the restore-confirm handler drain its own request's pending
work before `restoreFromZip()`, so a queued script-version write can't land
after the replay and clobber the restored commit. Residual window (Codex):
pending work is scoped per request, so when a *concurrent* request ran
`initDb()` its queued marker write is invisible to the restore's flush.
Requires a cold deploy-boot racing an owner restore on one isolate; impact is
only the flash's commit hint. Fix direction: an isolate-level in-flight set
in `src/shared/pending-work.ts` + `flushAllPendingWork()` for the restore
path; extend the race harness in `test/lib/server-backup.test.ts` ("a
deploy's first request cannot clobber...") with a concurrent cold GET.

## Equivalent-mutant entries challenged by review (from PR #1717)

*Origin: CodeRabbit review on PR #1717 (import-graph slimming). The challenged
entries live in `scripts/mutation/equivalent-mutants.txt` but were added by the
balance-payments work (PR #1697) and only passed through #1717 via a merge of
main, so relitigating them there was out of scope.*

CodeRabbit argued three suppressions don't meet the file's "no possible input
distinguishes it" bar because they rely on *current-consumer* behaviour rather
than interface guarantees:

- **`src/shared/db/payment-references.ts:88` (ORDER BY removal).** The entry's
  rationale is that every consumer dedupes `sessionIds` or uses them in an
  `IN (...)`. That is consumer-dependent: a future consumer that renders or
  compares the array order would observe the mutant. Either normalize ordering
  at the exported API boundary (e.g. sort `sessionIds` before returning) and
  keep the suppression, or drop the entry and pin the order with a test.
- **`src/features/admin/attendees-edit.ts:68` (`bookings[0]` → `bookings[1]`).**
  The entry leans on a data invariant (the LIMIT 1 row's `listing_id` matching
  `attendee.listing_id`). Multi-parent bookings exist (see
  `test/lib/db/attendee-multiparent-rows.test.ts`), so an attendee whose first
  booking is on a different listing may be constructible. Preferred fix: add a
  regression test with divergent booking/attendee listing ids asserting the
  refresh context picks `bookings[0].listing_id`, then delete the entry.
- **`src/shared/merge/attendee-merge.ts:715/:722` (`merge-unbill`/`merge-credit`
  keyParts).** The entry argues the prefixes feed only HMAC'd
  `event_group`/`reference` digests that nothing queries. The digests are still
  persisted, so the safest resolution is a test that pins the two legs'
  event-group derivation (or an explicit storage-contract note), then removal.

Starting point: each entry's full rationale is in the file next to the line
numbers above; the mutation harness is `deno task mutation --source <file>
--test <suite>`.

## Stop patching @std/expect's `toContain` (from PR #1712)

`test/test-utils/fast-expect.ts` globally overrides `@std/expect`'s built-in
`toContain` via `expect.extend`, to skip the built-in's eager pretty-printing of
the whole searched value on every (passing) assertion — the speed win documented
in AGENTS.md's "Fast Tests" section (landed in PR #1702). PR #1712 removed the
`#test-utils` barrel that used to side-effect-import it, so the override is now
loaded via a `--preload ./test/test-utils/fast-expect.ts` flag on the test
harness (`scripts/test-harness.ts`) and the mutation runner
(`scripts/mutation/runner.ts`).

The preference is to **not** patch a standard library if we can avoid it. This
is genuinely out of scope for the barrel-removal PR (it would touch far more than
that PR's remit), so it's recorded here rather than done there.

Fix direction: replace the global `toContain` override with `@std/assert`'s
native `assertStringIncludes` (and `assertArrayIncludes` where a `toContain` is
used on arrays), which is already fast — it does not pretty-print on success — so
no `@std` behaviour is patched. Migrate the `expect(bigHtml).toContain(...)` call
sites (thousands, mostly rendered-HTML assertions), then delete `fast-expect.ts`,
its test, the `--preload` flag in both runners, and the "Fast Tests" note that
documents the override. Confirm the suite's slow-test report
(`SLOW_TEST_THRESHOLD_MS`) doesn't regress. Start points: `fast-expect.ts` for
what it did and why, and grep `\.toContain(` under `test/` for the call sites.

## Code-quality detector & test-strengthening follow-ups (from PR #1729)

*Origin: CodeRabbit review of PR #1729, deferred as out of scope for that
complexity-only refactor (which had to preserve behavior). All of these are
pre-existing behaviors carried over unchanged from `main`, not regressions.*

### 1. `skipTypeParams` should not treat the `>` in `=>` as a closing angle bracket

`test/lib/code-quality/detectors.ts` — `skipTypeParams` counts every `>` as a
type-parameter close, so a type alias whose params contain an arrow default,
e.g. `type A<T = () => void> = { ... }`, is parsed as ending at the arrow and
`parseTypeAliasBody` silently ignores the (valid) alias. The sibling helper
`angleDepthDelta` already handles this token correctly (it ignores a `>`
preceded by `=`).

Fix direction: reuse `angleDepthDelta` in `skipTypeParams`. Note the naive
rewrite reintroduces an unreachable `return i` fall-through that fails the
repo's 100% line/branch coverage gate — so the fix must be paired with a
covering test that exercises an arrow-in-type-param alias (and keep the
fall-through on the covered path, as the current loop-with-`break` form does).

### 2. `skipTemplateSubstitution` should skip comment contents

`test/lib/code-quality/detectors.ts` — the template-substitution scanner tracks
brace depth but does not skip comments, so a `}` inside a comment inside a
`${...}` prematurely closes the substitution; a later nested backtick can then
end the outer template early and leak commas into `parseArgList`. Repro shape:
`` `${/* } */ `x,y`}` ``.

Fix direction: within the depth loop, skip line/block comments (a `skipComment`
helper) before the brace-depth checks, and add a direct regression test for the
comment-with-`}`-then-nested-template case asserting `parseArgList` doesn't
misinterpret the comma.

### 3. `foldOutcomeValid` should assert rejected folds preserve the prior quantity

`test/lib/fold-tree.test.ts` — for the above-cap (rejected) case the validator
checks `recordedQty !== running`, which only proves the quantity wasn't clamped
to the attempted total; it doesn't prove the rejected fold left the *prior*
recorded quantity unchanged.

Fix direction: capture the recorded quantity before calling `foldChild`, thread
it into `foldOutcomeValid`, and assert exact equality against that pre-fold
value for rejected outcomes (retaining the accepted-case checks).

### 4. `mutation.ts` CLI value flags should fail fast on a missing value

`scripts/mutation.ts` — in `applyArg`, a recognized value flag (`--source`,
`--test`, `--timeout`, `--jobs`) with no following token falls through and is
collected as a positional, so it surfaces later as a misleading glob/file error
instead of a clear CLI usage error. (Matches `main`'s original `next !==
undefined` guard behavior — pre-existing.)

Fix direction: in `applyArg`, when `VALUE_FLAGS[arg]` exists but `next` is
`undefined`, raise a clear "missing value for <flag>" usage error rather than
pushing the flag to `positional`; keep consuming/returning true when a value is
present.
