# Staged-checkout branch split plan

## Goal

The staged-checkout branch is too large to review or merge safely as one pull
request. Against `origin/main` at `32a47a03`, it changes 248 files with about
11,700 added lines. Its existing commits are not useful pull request boundaries:
the first feature commit changes 135 files, and the final review commit mixes
many separate fixes across another 113 files.

Rebuild the work as small semantic changes from current `origin/main`. Do not
cherry-pick the broad branch commits. Each job below has its own persistent git
worktree, branch, agent, and pull request.

The agents must preserve newer work already on main, especially:

- Use `legMatches` from `src/shared/ledger/legs.ts`; do not restore a parallel
  transfer-leg matcher from the feature branch.
- Use `parseDateMs` from `src/shared/dates.ts` in any moved backup code; do not
  reintroduce direct `Date.parse` calls.
- Run focused tests while developing. Do not manually run mutation testing or
  repeated full precommit runs. The commit hook and CI own the full gate.

## Merge-first pull requests

### 1. Stripe refund status correctness

**Branch:** `split/stripe-refund-status`

**Worktree:** `.pi-worktrees/stripe-refund-status`

Only report a Stripe refund as complete when Stripe returns
`status === "succeeded"`. Pending, action-required, failed, and cancelled
refunds remain unresolved.

Primary scope:

- `src/shared/stripe-provider.ts`
- `test/lib/stripe/provider.test.ts`
- Existing refund mocks that currently return only an ID and must return a
  realistic successful status.

Do not bring in checkout-stage state, checkout expiry handling, webhook event
reconciliation, or staged-refund retry code.

Acceptance:

- Direct tests cover every Stripe refund status.
- Existing refund-flow tests still model successful refunds accurately.
- The PR contains no checkout-stage schema or runtime changes.

### 2. Atomic placeholder refund ledger

**Branch:** `split/placeholder-refund-ledger`

**Worktree:** `.pi-worktrees/placeholder-refund-ledger`

Post a placeholder's received payment and completed cash refund as one atomic
transfer-group write. A conflict in the refund leg must roll back the payment
leg as well.

Primary scope:

- `src/shared/refund-ledger.ts`
- `test/shared/refund-ledger-placeholder.test.ts`
- A focused split of existing refund-ledger tests if needed to keep files small.

Use the current main branch's shared ledger matching helpers. Do not bring in
checkout stages, held-cash admin guards, transfer batch primitives needed only
by staged activation, or refunding-state transitions.

Acceptance:

- A refund-reference collision proves neither transfer group is committed.
- Payment-only recording remains correct when no provider refund completed.
- Existing attendee refund behavior is unchanged.

### 3. Stage-neutral attendee purge unification

**Branch:** `split/attendee-purge`

**Worktree:** `.pi-worktrees/attendee-purge`

Replace the separate single-attendee and orphan dependent-row deletion lists
with one shared statement builder for tables that already exist on main.

Primary scope:

- `src/shared/db/attendees/delete.ts`
- `src/shared/db/orphan-attendees.ts`
- Existing attendee-delete and orphan-purge tests.

The shared main-ready dependent set is `processed_payments`,
`attendee_answers`, `listing_attendees`, `system_notes`, and `service_costs`.

Do not add `checkout_stages`, stage-last ordering, stale payment-claim cleanup,
or checkout cancellation/pruning. Those extend this mechanism later.

Acceptance:

- Single deletion and orphan deletion use the same dependent-row mechanism.
- Service costs and every existing dependent table are still removed.
- The change is a real deduplication and preferably a net deletion.

### 4. Stripe webhook setup hardening

**Branch:** `split/stripe-webhook-setup`

**Worktree:** `.pi-worktrees/stripe-webhook-setup`

During Stripe setup, delete both the recorded endpoint and stray endpoints with
the exact same site webhook URL. Save the new endpoint ID and signing secret
atomically. Use one shared payment-webhook URL helper.

Primary scope:

- `src/shared/stripe.ts`
- `src/shared/db/settings.ts`
- `src/shared/payment-webhook-url.ts`
- The admin settings callers that construct the URL today.
- `test/lib/stripe/webhook.test.ts`
- A settings atomicity regression if needed.

Never delete endpoints for another URL. If endpoint listing fails, the recorded
endpoint cleanup and replacement must still proceed.

Do not subscribe to `checkout.session.expired`, add event-version settings, or
add first-request webhook reconciliation. Those require the staged runtime.

Acceptance:

- Same-URL stale endpoints are removed.
- Other URLs are untouched.
- Endpoint ID and secret cannot be partially saved.
- Listing failure follows the documented best-effort path.

### 5. Owner-safe links in attendee notes

**Branch:** `split/owner-note-links`

**Worktree:** `.pi-worktrees/owner-note-links`

Owner-only ledger links embedded in attendee notes remain links for owners and
become plain text for roles that cannot open them. Use the final token-aware
Markdown implementation immediately; do not port the earlier regex version.

Primary scope:

- `src/shared/markdown.ts`
- `src/ui/templates/admin/attendee-notes.tsx`
- Owner-role plumbing through attendee, listing overview, and roster note
  surfaces.
- `test/shared/markdown.test.ts`
- Note and attendee page rendering tests.

The parser must handle inline, reference, collapsed-reference, shortcut, and
automatic links, including links nested in lists, blockquotes, and tables. It
must preserve safe Markdown and code spans.

Do not bring in deleted-listing display, pending-checkout UI, held-cash actions,
or other attendee-page changes from the mixed source commits.

Acceptance:

- Every rendered link is reachable by the viewer's role.
- Owners retain the ledger links.
- Non-owners retain readable note text and formatting without a dead link.

### 6. QR checkout error propagation

**Branch:** `split/qr-checkout-errors`

**Worktree:** `.pi-worktrees/qr-checkout-errors`

Pass the payment flow's error message and HTTP status through the QR checkout
route instead of replacing every error with a generic HTTP 500 page.

Primary scope:

- `src/features/public/qr-book.ts`
- `src/ui/templates/public/errors.tsx`
- `test/lib/server-qr-book.test.ts`

Keep main's current checkout creator and intent flow. Use an existing provider
validation error for the regression rather than importing staged checkout or
the staged sold-out preflight.

Acceptance:

- A provider validation refusal keeps its message and HTTP 400 status.
- A missing/null checkout result still renders the existing generic HTTP 500
  response.
- No staged-checkout imports or schema changes are included.

## Merge order

The six PRs are independent enough to develop in parallel. Prefer merging in
this order when several become ready at once:

1. Stripe refund status correctness.
2. Atomic placeholder refund ledger.
3. Stage-neutral attendee purge unification.
4. Stripe webhook setup hardening.
5. Owner-safe links in attendee notes.
6. QR checkout error propagation.

Rebase each open PR after earlier ones merge, resolving toward one shared
mechanism rather than preserving parallel implementations.

## Deferred foundations

After these six PRs are reviewed and merged, reconvene before splitting the
foundational work:

1. Canonical booking lines and booking date fields.
2. Shared SQL, capacity, modifier, and batch-write primitives.
3. Atomic ordinary booking and payment recovery.
4. Behavior-preserving backup module split.
5. Dormant checkout-stage schema, rollback fences, and certified backups.
6. One coherent staged-checkout runtime PR containing stage creation,
   activation, refund lifecycle, cleanup, expiry handling, and admin mutation
   guards.

Do not enable stage creation across separate deployments from its payment,
refund, cleanup, and mutation protections.

Before the staged runtime is mergeable, also resolve these findings from the
split review:

- One validation path currently asks the provider to refund before durably
  changing the stage to `refunding`.
- Old `refunding` stages have no bounded reconciliation path.
- Admin table/CSV pending projection must use the same open-state definition as
  mutation guards, including `refunding`.
