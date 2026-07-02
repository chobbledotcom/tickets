# TODO — remaining follow-ups

The root-level planning/design docs were removed once their work shipped. This
file captures the follow-ups that were *not* yet done when those docs were
retired. Each item names the doc it came from — the full design detail is
recoverable from git history (e.g. `git show HEAD~1:<file>.md`).

## Booking unification (from `booking-unification.md`, `booking-unification-phase2.md`)

Phases 1 & 2 (unified booking-node tree: builder, one recursive renderer,
unified fold/price/capacity/revalidate, v2 signed per-node metadata) shipped in
#1462. Remaining:

- **Row-level admin identity (Phase 3 prerequisite).** Attendee-merge
  `bookingKey` (`src/shared/merge/attendee-merge.ts`) and check-in targeting key
  only by `listingId:startAt:parentListingId` — both must learn
  `package_group_id`/`nodeKey` before duplicate listing ids across paths become
  possible. Add these cases to the persistence tests first. Not a live defect
  today (no duplicate listing-ids-across-paths without Phase 3).
- **Phase 3 — unified edge store (optional, one-way door).** Migrate
  `listing_parents` and `group_listings` into a single edge table (or make one a
  view of the other). Shipping Phases 1–2 and stopping is a successful outcome;
  only earn this once it's demanded.
- **Phase 4 — buyer-choice children inside a package (optional).** Build on
  demand when a concrete booking requires it.
- **Confirm v1 drain bridge.** The planned read-only v1 metadata bridge + its
  drain-window regression test were not built as a distinct piece. The v2 schema
  added `k`/`r` as *optional* fields to the existing `e/q/p` line shape, so
  pre-cutover sessions still parse — confirm this was an intentional
  simplification rather than a gap.

## Entity pages migration (from `edit-pages.md`)

The `defineEntityPage` framework + the attendees migration (slice 1) shipped
(#1500, #1502, #1503). Remaining slices:

- **Listings** — collapse detail + edit into one entity page.
- **Modifiers** — the third copy of the composition.
- **Groups, users, questions, built-sites, attendee-statuses, holidays,
  history/:hmac** — one small PR each.
- **Generalize `system_notes`** from attendee-only to `(entity_type, entity_id)`
  so any entity page can carry a notes section.

## Pages / admin nav (from `pages.md`)

Site → Pages (admin CRUD, public `/page` route, recursive public nav) shipped
(#1496). Remaining (optional, flagged non-blocking in the plan):

- **Step 6** — migrate the admin nav onto the shared recursive renderer to
  delete the last of the fixed-depth `Section`/`NestedSub` code in
  `src/ui/templates/admin/nav.tsx`.

## Servicing (from `servicing.md`)

All P1/P2 fixes and the unified money schema shipped (#1499, #1501). Remaining:

- **Modifier money fields.** Make the modifier `calc_value` / `min_subtotal`
  fields currency-aware via the shared money schema. They still parse via
  `Number.parseFloat` in `src/ui/templates/fields.ts` (~lines 924, 970).
  `calc_value` is polymorphic and stored in *major* units, so the fixed case
  needs cross-field (`calc_kind`-aware) validation — left as a self-contained
  change.
- **Read-only default-deny registry (optional).** The current path-based
  allowlist already fails closed; a registry-driven per-route `readOnly` flag
  remains an optional future refactor.

## Test quality (from `TEST_QUALITY_IMPROVEMENTS.md`)

Mutation testing (the priority-1 item) shipped as a precommit gate
(`deno task mutation`, `precommit:mutation`). Remaining:

- **Property-based tests (item 5)** — `fast-check` is used in only one test.
  Add the proposed properties: slug generation, CSV round-trips (commas/quotes/
  CRLF), date formatting across timezones, token parsers, URL safety.
- **Weak-assertion audit lifecycle (item 6)** — `scripts/test-quality-audit.ts`
  exists; wire its escalation into CI (informational → warning → review gate for
  touched files).
- **Production-shape checks (item 7)** — stand up a scheduled/release-blocking
  suite: edge-bundle smoke, backup/restore drills, concurrent-reservation,
  webhook replay/idempotency, load tests, security scans.
- **Ongoing ratchets (items 2 & 3)** — keep replacing compound-boolean
  assertions and strengthening presence checks in new/touched files.
- **Metrics** — surface mutation-score baselines / surviving-mutant counts as a
  tracked artifact.

## Settings on-demand loading (from `settings-plan.md`)

The keyed on-demand settings loader shipped (`loadAll` removed, per-route
bundles, dev read-audit). Remaining (deferred by design):

- **Generation counter** for concurrent partial-load/write races — only add if
  profiling shows real concurrency.
