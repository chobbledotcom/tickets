# Task: Make `saveAttendeeAnswers` truly atomic

You are picking up a deferred follow-up from PR #1678 "Split questions.ts up".

## Background

`src/shared/db/questions/attendee-answers.ts` has `saveAttendeeAnswers`, which
replaces every listed attendee's answers (delete old, insert new). It currently
runs as **two separate committed batches**:

1. `executeBatch([... DELETE FROM attendee_answers WHERE attendee_id = ? ...])`
   — the DELETE batch (commits on its own)
2. `getOrCreateStringIds(...)` — interns free-text strings (itself a
   `executeBatchWithResults` write batch: INSERT OR IGNORE + UPDATE `created` +
   a read-your-own-writes SELECT)
3. `executeBatch([... INSERT INTO attendee_answers ...])` — the INSERT batch
   (commits on its own)

A CodeRabbit review (comment #2, "Delete and insert should be atomic") flagged
that if the INSERT batch fails after the DELETE committed, the attendee is left
with no answers until a manual re-save.

The PR reply deferred this to a follow-up, explaining the real constraint:
libsql's `getDb().batch()` always starts its own implicit transaction, so
wrapping the two `executeBatch` calls in `withTransaction` would NOT make them
atomic — each `executeBatch` still commits as its own transaction. True
atomicity requires **threading a `TxScope` through `getOrCreateStringIds`**
(replacing its internal `executeBatchWithResults` with per-statement
`tx.execute`), so the whole DELETE + string-intern + INSERT flow runs inside one
interactive write transaction.

That follow-up is this task.

## Goal

Rework `saveAttendeeAnswers` so the DELETE, string interning, and INSERT all run
inside one `withTransaction`, committing (or rolling back) as one. This means:

1. `getOrCreateStringIds` must accept an optional `TxScope` (or be callable as
   `getOrCreateStringIdsTx(tx, texts)`) so its INSERT OR IGNORE + UPDATE
   `created`
   - SELECT all run on the open transaction's `tx.execute` instead of a separate
     `executeBatchWithResults` batch.
2. `saveAttendeeAnswers` wraps its whole body in
   `withTransaction(async (tx) => {
   ... })`, using `tx.execute` for the
   DELETE statements and the INSERT statements (instead of `executeBatch`), and
   calling the transactional `getOrCreateStringIds` for string interning.
3. The `questionIdsByAnswerId` and `existingQuestionIds` reads between the
   DELETE and INSERT must also run on the same `tx` (they currently use
   `queryAll` / `columnMapByIds`, which start their own read transactions —
   these need to run on the tx too so they see the DELETE's effects within the
   transaction).

## Key files (read these first)

- `src/shared/db/questions/attendee-answers.ts` — `saveAttendeeAnswers` (the
  function to rework) and its doc comment (lines ~90-155) which records the
  current gap and the follow-up plan. **Update the doc comment** once the gap is
  closed.
- `src/shared/db/questions/strings.ts` — `getOrCreateStringIds` (needs a
  transactional variant)
- `src/shared/db/client.ts` — `withTransaction`, `TxScope`, `executeBatch`,
  `executeBatchWithResults`, `queryAll`, `queryOne`. Read `withTransaction`'s
  implementation (~line 471) and `runWriteTransactionOnce` (~line 410) to
  understand how `tx.execute` works, the round-trip guard, and cache
  invalidation.
- `src/shared/db/query.ts` — `columnMapByIds` (used by `questionIdsByAnswerId`);
  check whether it can accept a `TxScope` or needs a transactional variant.

## Constraints (critical)

1. **Read-your-own-writes**: `getOrCreateStringIds`'s trailing SELECT
   (`SELECT id, text_index FROM strings WHERE text_index IN (...)`) must see the
   rows just inserted by the preceding INSERT OR IGNORE in the same call.
   Currently this works because `executeBatchWithResults` runs as one write-mode
   batch forwarded to the primary. Inside a `withTransaction`, `tx.execute` for
   each statement shares the same transaction so it should still work — but
   verify this carefully by reading `runWriteTransactionOnce` and testing
   explicitly.
2. **Trigger ordering**: The DELETE's trigger decrements `strings.used_count`;
   `getOrCreateStringIds` then refreshes `created` on the strings it re-inserts.
   The DELETE must still run before the string refresh so a consistent
   `used_count` snapshot is seen. A transactional version must preserve this
   ordering inside the tx (DELETE first, then string interning, then INSERTs).
3. **Round-trip guard**: `runWriteTransactionOnce` has
   `enforceTransactionRoundTripGuard` that guards against too many sequential
   round-trips. `saveAttendeeAnswers` builds its INSERT statements as multi-row
   VALUES batches (one statement per attendee per answer-type) — keep that
   batched-statement shape so the transaction doesn't exceed the round-trip
   limit. Do NOT switch to one `tx.execute` per individual row.
4. **Keep the existing normalization and statement-building logic intact** —
   only change the execution boundary (separate batches → one transaction).
5. **Cache invalidation**: `withTransaction` fires cache invalidations after a
   successful commit, driven by the written SQL. The current separate
   `executeBatch` calls invalidate per-batch. The transactional version should
   invalidate once after commit — verify `runWriteTransactionOnce` does this
   correctly for your `tx.execute` calls.
6. **Update the doc comment** on `saveAttendeeAnswers`: remove the "narrow gap"
   / "left as a follow-up" language since the gap is now closed. Explain the new
   transactional shape.

## Branch context

This branch (`save-attendee-answers-tx`) is based off `split-questions` (PR
#1678). Once `split-questions` merges to main, rebase onto main:

```bash
git fetch origin main
git rebase origin/main
```

## Verification

Run these from the worktree root
(`/home/user/git/tickets-4-save-attendee-answers-tx`):

```bash
# Typecheck (incl. test files — mirrors CI)
deno task typecheck

# Lint (strict, read-only)
deno task lint:ci

# cpd (0% threshold, non-negotiable)
deno task cpd

# The tests that exercise saveAttendeeAnswers most directly:
deno task test:files test/shared/db/questions/attendee-answers.test.ts
deno task test:files test/lib/server-webhooks/custom-questions-single.test.ts
deno task test:files test/lib/server-webhooks/custom-questions-multi.test.ts
deno task test:files test/lib/server-attendees.test.ts

# Full precommit (typecheck + lint + cpd + tests + mutation) — the only check
# that mirrors CI exactly. Run this before declaring done.
deno task precommit
```

Add a regression test that would have caught the gap the reviewer identified: a
save that fails during the INSERT phase (e.g. by stubbing the INSERT to throw)
should leave the attendee's existing answers intact (the DELETE rolled back),
not empty. AGENTS.md: "Every bug fix ships with a regression test."

## When done

1. Commit with a clear message (the pre-commit hook runs `deno task precommit`).
2. Push: `git push -u origin save-attendee-answers-tx`.
3. Open a PR targeting `main` (once `split-questions` is merged) or
   `split-questions` (if it isn't yet) — ask the user which.
4. Reply on the CodeRabbit thread in PR #1678
   (`src/shared/db/questions/attendee-answers.ts`) noting the follow-up landed,
   with a link to the new PR.
