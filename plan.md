# Plan: harden the staged-checkout branch (PR #1764 fixes)

Fixes for the issues found reviewing `fix/committed-booking-refunds` ("Stage paid
bookings until payment succeeds"). Work lands on `claude/branch-review-comparison-pcwbvd`
(cut from the PR head) and will be PR'd **against `fix/committed-booking-refunds`**
as a stacked fixes-PR, so #1764 absorbs it before it merges to main.

Ordering follows "hardest first". Every fix ships with a regression test that
fails before the fix (repo rule). Each numbered fix is one commit.

---

## P1 — Give staged sessions a terminal path (the safety net)

**Bug (HIGH):** for staged sessions the "refund" arm of `decideUnexpectedCreate`
is dead — the staged attendee always matches the prepared ticket token, so every
deterministic error thrown inside `activateStagedBooking` (stage mismatch,
"already active", encryption failure, "not finalized") is rethrown forever:
reservation cycles stale every ~5 min, customer's money held, no ticket, no
refund, no record.

**Fix (refined from the first draft):** the deterministic errors aren't equally
refund-safe, so `assertStageMatches` stops throwing and returns structured
outcomes with three distinct terminal shapes:

- **`stage_mismatch`** (line keys changed; rows still quantity 0, provably
  nothing committed) → flows through the normal keep-and-refund path
  (`storeRefundedBooking`) with a new `order_changed` refund reason: stage
  `failed`, refund, system note, ledger record, `markSessionFailed` persists it
  for replays. This is what turns the listing-type flip (bug 2), annotation
  divergence (bug 8) and qty-0 admin line edits from crash-loops into refunds.
- **`stage_active`** (a staged row already has quantity ≠ 0 — rows may be LIVE,
  so auto-refunding would break the PR's own "never refund beside a live
  ticket" invariant) → a terminal NO-refund operator conflict: classified
  error log + system note telling the operator exactly what to reconcile,
  customer told the organiser must confirm the booking, status 200 so the
  outcome is recorded and replays are consistent. Money moves only by operator
  decision (house rule: operator decides genuine conflicts).
- **Transaction-internal throws** (DatabaseBusyError, lost finalize row,
  encryption/system failures) keep today's rethrow-and-retry semantics — they
  are transient or system-down, where retry is correct and refund would be
  wrong. `recovery-decision.ts` keeps rethrow for staged sessions and gains a
  comment explaining why that is now sound (only transient/system errors can
  reach it once the two deterministic cases are structured).
- `ActivationFailure` unifies to the underscore vocabulary
  (`sold_out`, not `"sold-out"`), deleting the two mapping ternaries in
  `create.ts` (also resolves the reviewed spelling-drift finding).

**Tests:** update the two tampered-stage regressions to the new expectations
(mismatch → refunded terminal outcome + idempotent replay; active → no-refund
conflict outcome + note + idempotent replay); the lost-finalize and
missing-encryption tests keep their retryable 400s.

## P2 — Pending-stage guard for admin mutations

**Bug (MEDIUM):** staged attendees render as ordinary no-quantity attendees;
any admin edit (quantity, lines, servicing) or merge mid-checkout bricks the
session (P1 downgrades that to an unwanted refund — still a lost sale).

**Fix:**

- New shared predicate in `checkout-stages.ts`:
  `attendeeIdsWithPendingStage(ids: number[]): Promise<Set<number>>` (array-in,
  set-out — one path for one-or-many).
- Gate the mutating admin paths on it, failing closed with a plain flash
  ("This booking is mid-payment. Wait for the payment to finish or delete the
  record."): unified attendee form POST (`attendee-form-routes.ts`), servicing
  edits, attendee merge (both as source and as target), bulk actions that
  mutate lines/quantities.
- **Delete stays allowed** — the cascade removes the stage and a late payment
  books fresh through the no-stage path (designed escape hatch).
- Admin lists/pages show a "Payment in progress" badge on staged attendees
  (malleable-software rule: expose, don't hide). Copy goes in the locale
  catalog.

**Tests:** each gated route returns the flash and mutates nothing for a staged
attendee; a normal attendee is unaffected; delete still works; badge renders.

## P3 — Merge repoint + stage resolution inside `storeRefundedBooking`

**Bug (HIGH):** the merge batch repoints `processed_payments` and transfers but
not `checkout_stages`, and deletes the source attendee directly — a dangling
stage then auto-refunds the buyer at payment time and creates a duplicate
placeholder (the one reachable case of `recovery.ts:104`'s missing stage arg).

**Fix (refined — no repoint):** repointing the stage to the merge target would
make later stage handling (PII re-encryption on failure, activation) write into
the merged TARGET attendee — clobbering its PII with the checkout intent's.
The safe shape is exclusion plus belt-and-braces:

- P2's guard blocks merging an attendee with a pending stage (as source AND as
  target) with a plain conflict message — mid-payment records stay out of
  merges entirely.
- `getCheckoutStage` verifies the staged attendee still exists (JOIN
  attendees); a dangling stage (any future deletion path that misses the
  cascade) returns null with a loud classified error, so the payment books
  fresh through the no-stage path — the correct outcome — instead of
  crash-looping or auto-refunding.
- Remove the optional `stage` parameter from `storeRefundedBooking`; it
  resolves the stage itself, so no caller can forget (deletes the
  `recovery.ts` omission class). Callers in `index.ts` stop threading `stage`.

**Tests:** merge of a staged attendee is refused both directions; a
hand-dangled stage row logs the classified error and the payment books fresh;
the recovery refund path on a stage-bearing session marks it `failed` and
reuses its attendee.

## P4 — Stop capacity-gating quantity-0 staging inserts

**Bug (MEDIUM):** staging runs the capacity condition with quantity 0, so an
overbooked listing (a supported admin state) can't even *start* checkout —
deterministic on QR flows (`skipToCheckout` has no availability preflight),
generic 503 after the provider session was already created.

**Fix:** `stageCheckout` passes `allowOverbook: true` (staged rows are
quantity-0; real capacity is enforced at activation, which is the point of the
design). Mirrors `storeRefundedBooking`'s own quantity-0 insert.

**Tests:** overbooked listing → staging succeeds, checkout URL returned;
activation still refuses when capacity doesn't fit the real quantities.

## P5 — Mark the stage on every terminal failure

**Bug (MEDIUM):** non-404 `validateAllItems` failures (e.g. 410 "registration
closed while you were paying") refund the customer but never touch the stage:
the pending row + full PII is then shielded from prune by the
`NOT EXISTS (processed_payments)` guard for ~90 days (13× the 7-day promise),
with no note explaining anything.

**Fix:** route staged sessions' non-404 validate failures through
`storeRefundedBooking(...)` (which now resolves the stage itself — P3) with an
appropriate refund spec, unifying them with the deleted-listing 404 handling:
stage `failed`, system note, ledger record, refund. Non-staged sessions keep
today's behavior.

**Tests:** staged session + registration-closed-mid-payment → refund, stage
`failed`, note present; the stage is no longer pending so the prune contract
holds.

## P6 — Fail closed on a non-pending stage at activation entry

**Bug (MEDIUM):** `getCheckoutStage` ignores `state`; after the
processed_payments row is pruned (~90 days) a late redelivery can re-activate a
`failed` (already-refunded) stage if the placeholder-refund ledger legs are
also missing.

**Fix:** in `index.ts`, a stage with `state !== "pending"` →
`alreadyHandledSession(...)` (status 200, nothing re-processed). One-line
defense-in-depth; the ledger preflight remains the primary rail.

**Tests:** `failed` stage + fresh reservation + empty ledger → 200
already-handled, no booking, no refund call.

## P7 — Annotation symmetry + a real parent/child staging test

**Bug (LOW today, landmine):** staging runs `annotateOrderParents` (stamps
`parent_listing_id` when a child's parent is in the same order and no fold
allocations exist); activation compares raw `orderBookings` keys. Unreachable
through today's routes (folds always carry allocations) but any future
parent+child route — or an edge created mid-checkout — walks into P1's
(previously fatal, now refund-shaped) mismatch. The only covering test syncs
both sides by hand, masking the asymmetry.

**Fix:** run `annotateOrderParents(bookings)` in `createAttendeeForSession`
before calling `activateStagedBooking`, so both sides derive keys from the same
pipeline. Residual divergence (edge added/removed mid-checkout) degrades to
P1's terminal refund.

**Tests:** replace the hand-synced test with one that stages a parent+child
order **through `stageCheckout`** (no allocations) and activates it **through
`createAttendeeForSession`** — proving the two sides agree end-to-end.

## P8 — Checkout expiry and retention alignment

Agreed direction from review discussion:

- `stripe-provider.ts`: set `expires_at` on Checkout Session creation — new
  limits.ts value `CHECKOUT_SESSION_EXPIRY_MINUTES` (default **60**, floor 30
  per Stripe). SumUp already expires at 30 min inherently; Square payment links
  have no expiry parameter (verified against the API in use — if none, Square
  simply relies on the pruner as today).
- Handle Stripe's `checkout.session.expired` webhook event →
  `discardPendingCheckoutSessions([sessionId])` (the NOT EXISTS guard makes
  this race-safe). Add the event type to the auto-created webhook endpoint's
  `enabled_events` (existing endpoints get updated by the same setup path).
- On the cancel-page discard, also call Stripe's
  `POST /checkout/sessions/:id/expire` so a cancelled checkout can't be
  resurrected from an old tab (best-effort; the no-stage fallback already makes
  a resurrection harmless).
- `PRUNE_CHECKOUT_STAGES_RETENTION_DAYS` stays default 7 (it's already an env
  knob; Square is the constraint). Document in the env-var docs that
  Stripe/SumUp-only deployments can safely lower it to 1 day. Note the
  `PRUNE_UNUSED_STRINGS_RETENTION_DAYS` coupling (free-text answers must
  outlive the longest completable checkout).

**Tests:** provider session creation carries the expiry; expired event discards
the stage (and only pending, unclaimed ones); cancel path calls session-expire
best-effort.

## P9 — Polish (verified cleanup batch, one commit series)

- `checkout-stages.ts`: use `inPlaceholders`; drive the attendee-dependent
  deletes from an exported `DEPENDENT_ROW_TARGETS` (delete.ts) instead of a
  hand-list; rename `getCheckoutStage` → `getCheckoutStageOrNull` (house
  convention — the branch itself did this rename for the ledger replay); drop
  the unread `provider` field from the select/type (`state` gains a real reader
  in P6 and stays).
- `index.ts`: move the stage fetch below the ledger-replay preflight (saves a
  primary round-trip on every replayed delivery).
- `activate.ts`: use the `update()` builder for the pii_blob write; pin
  `loadExistingLines` reads to the primary inside activation (replica-lag
  throw is self-healing but pointless).
- `committed-entries.ts` + `attendees/create.ts`: export one shared
  attendee-entry projection (`buildAttendeeResult`) and use it in
  `committedEntries` instead of the hand-rolled 20-field literal.
- `checkout-stages.ts` `stagedBookings`: accept the caller's already-loaded
  `ListingWithCount` rows (all four call sites have them) instead of
  re-querying.
- Batch the two-execute spots: `store-refund.ts` staged-path PII update +
  stage mark; `contact-tokens.ts` `recordOrderActivity` email+phone upserts.
- Unify the cancel-path vs classify-path "session returned unpaid" predicate
  into one shared resolver (today: `!== "paid"` vs `=== "failed"`).
- `test/test-utils/db-helpers/processed-payments.ts`: stop re-implementing the
  deleted production finalize SQL — fixtures go through the real
  guarded finalize path (or a thin wrapper over it).

## Explicitly deferred (recorded in TODO.md, not this PR)

- Rewrite `activateStagedBooking`'s interactive transaction as a guarded batch
  (create-batch.ts pattern) to cut ~10 sequential primary round-trips — real
  perf win, but a substantive redesign of a money path; separate PR.
- Reuse #1775's `createSystemNoteOnce` for the store-refund replay
  duplicate-note residue once that PR merges (it owns the helper).
- `defineTable`-izing `checkout_stages` (bespoke row mapping) — worth doing
  when the table next grows a column.

## Verification

- Per fix: targeted `deno task test:files` on the touched suites.
- End: full `deno task precommit` (typecheck incl. tests, strict lint, full
  suite, 0% duplication) + `deno task precommit:mutation` (100% kill rate on
  changed src↔test pairs).
- Rewrite the stacked PR's title/description in plain language when done.

## Defaults picked (veto if wrong)

1. **P1 semantics:** provably-uncommitted mismatches refund; "already active"
   becomes a NO-refund operator conflict (rows may be live — refunding there
   would break the PR's own invariant); transient/system throws keep retrying.
2. **Stripe expiry:** 60 minutes, as a configurable limit; global stage
   retention knob left at 7 days (Square constraint), docs tell
   Stripe/SumUp-only operators they can lower it.
3. **Branching:** fixes push to `claude/branch-review-comparison-pcwbvd`,
   PR based against `fix/committed-booking-refunds` (stacked on #1764).
