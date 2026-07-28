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

## Marketing screenshot visual cleanup

*Origin: visual audit of the mobile Retina screenshots generated from
`../tickets-site/scripts/screenshots/` on 2026-07-18.*

The screenshots use real application pages with scenario-specific custom CSS.
Keep fixes in those scenarios unless the same problem also appears in the normal
application UI. Regenerate each affected PNG and inspect the final image at its
actual size before marking an item complete.

**High priority:**

- **Fix the logistics card overflow and buttons.** In
  `scripts/screenshots/logistics.js`, the white booking card extends past the
  right edge of its blue day panel in `logistics-deliveries.png`. Both orange
  “Mark done” buttons are too narrow: the text touches the pill edges and looks
  vertically cramped. Keep the card inside its parent with border-box sizing,
  then give the buttons enough inline and block padding for the full label.
- **Give the daily-calendar states distinct, readable colours.** In
  `scripts/screenshots/daily-events.js`, the selected 3 August date uses white
  text on pale yellow in `daily-events-calendar.png`, which has poor contrast.
  The selected date and the other highlighted date also look almost identical.
  Use dark text and visibly different selected/today treatments while keeping
  both states clear without relying on colour alone.
- **Remove accidental focus outlines from checkout captures.** Several images
  end with whichever control was filled last still focused, producing an
  unrelated black or white outline: `charity-family-fun-day-checkout.png`,
  `promo-codes-and-add-ons-checkout.png`, `equipment-hire-booking.png`,
  `the-tempest-group-checkout.png`, and
  `garden-party-package-checkout.png`. Add one shared scenario helper that blurs
  the active control before capture, then use it for all filled checkout
  scenarios. Keep deliberate focus only in a screenshot that is specifically
  demonstrating keyboard focus.
- **Stack the Garden Party email field on mobile.** In
  `scripts/screenshots/packages.js`, “Your Email” and its input are squeezed
  onto one row in `garden-party-package-checkout.png`, unlike the name field
  above it. Make contact-field labels and controls consistently full-width so
  the input does not crowd the label.

**Polish:**

- **Shorten the bulk-email preview.** In `scripts/screenshots/bulk-email.js`,
  `bulk-email-preview.png` is about twice as tall as it needs to be because the
  warning copy, line height, and section gaps are oversized. Reduce the
  scenario font size/line height and vertical spacing without hiding or
  rewriting the real warning. Keep the recipients, subject, warning, and full
  message preview visible.
- **Tighten the balance summary.** In
  `scripts/screenshots/deposits-and-balance-payments.js`, the three totals in
  `deposits-and-balance-payments.png` have large vertical gaps and the payment
  action sits in an oversized empty panel. Reduce those gaps and panel padding
  while preserving a clear order: full price, already paid, balance due, then
  payment action.
- **Tighten oversized checkout headings.** The headings in
  `charity-family-fun-day-checkout.png` and `equipment-hire-booking.png` wrap
  with more line spacing than the forms use. Adjust only the scenario heading
  line-height and bottom margin so each title remains prominent but does not
  dominate the image.
- **Use the theme colour for custom-question controls.** In
  `scripts/screenshots/custom-questions.js`, the selected radio in
  `custom-questions-checkout.png` uses the browser’s bright blue default, which
  clashes with the brown bakery theme. Set `accent-color` to the scenario’s
  accessible brown accent and confirm the selected state remains obvious.
- **Reduce the listing-form crop height if it stays readable.** In
  `scripts/screenshots/listing-management.js`,
  `summer-sessions-listing-form.png` is nearly 2,000 pixels tall despite
  already being limited to the Basics fieldset. Tighten field hints, editor
  height, and section spacing rather than removing the date or venue. Keep all
  text comfortably readable at the rendered `split-image` size.

**Final visual check:**

- Regenerate every scenario-owned screenshot after the fixes and inspect for
  clipped text, overflowing boxes, accidental focus rings, low contrast,
  overlapping labels, inconsistent padding, and empty space at all four crop
  edges. Also render the affected `split-image` pages at desktop and mobile
  widths so a good source PNG is not undermined by its website placement.

---

## Migration lock: re-acquire after a tolerated missing settings table

*Origin: CodeRabbit review on PR #1965 (`src/shared/db/migrations/lock.ts`).*

`acquireMigrationLock(true)` returns a lease token when the `settings` table
does not exist yet, because the lock row lives in the very table the caller is
about to create. Setup, restore, and bootstrap rely on this: their route is
`initializeFreshSchema` → `sealFreshSchema`, which writes with a plain
`executeBatch` and never checks lock ownership, so the unpersisted token is
harmless there.

There is one narrow interleaving where it is not harmless. Request A probes a
missing `settings` table and takes the tolerated token; request B then creates
and stamps the schema; A's re-probe inside `runAcquiredMigrations` now sees
real markers, and if they read as stale it takes the pending-migrations branch
and reaches `recordMigrationBatch` with a token no row ever backed. The
ownership check finds zero rows and throws `MigrationInProgressError`.

The outcome today is fail-closed and retryable — no markers are written and no
data is corrupted, and another isolate genuinely was migrating — so this is a
tidiness issue, not a correctness bug. Still, A is running migrations without
holding a real lock until that final check catches it.

The fix: after the re-probe in `runAcquiredMigrations`, when the initial
acquisition was the tolerated one and the database now has a `settings` table,
re-acquire the lease (and bail out the normal way if another request holds it)
before entering the pending-migrations branch. A regression test needs to
control the interleaving: acquire with `allowMissingSettings` against a wiped
database, create and stamp the schema from another path, then assert the
lock-gated write either succeeds against a real lease or refuses before any
migration runs.

Out of scope for #1965, which moved this code verbatim out of `migrations.ts`
without changing behaviour.

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

## Entity pages migration — slices 4–5

*Origin: `edit-pages.md`.*

**Background.** "Entity pages" is one declarative, schema-driven, tabbed
framework (`defineEntityPage`) that replaces every hand-assembled admin "edit X"
page. A page becomes data: tabs of typed sections (summary / activity / actions /
custom), with per-tab authorization, path-segment tabs, and in-place 400-error
re-rendering. Migration is deliberately gradual and hardest-first.

**Already shipped — do not redo:**
- Framework: `src/shared/entity-pages/core.ts`, `src/features/admin/
  entity-pages.ts`, `src/ui/templates/admin/entity-pages.tsx`.
- Attendees: `src/features/admin/attendee-page.ts` (slice 1, PRs #1500, #1502,
  #1503).
- Listings: `src/features/admin/listing-page.ts` (slice 2).
- Groups: `src/features/admin/group-page.ts` (part of slice 4).
- Holidays: `src/features/admin/holiday-page.ts` (part of slice 4).
- Modifiers: `src/features/admin/modifiers.ts` (slice 3).
- Users, built sites, and attendee statuses (part of slice 4).
- API keys and logistics agents also use the framework.
- Site pages and news also use the framework through
  `src/features/admin/site-content-page.ts`.

**Remaining slices (each is roughly one PR; keep them small):**

- **Slice 4 — the long tail.** Questions and `history/:hmac` remain. Groups,
  holidays, users, built sites, and attendee statuses are complete.
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
  test (`test/shared/booking/fold-tree.test.ts`). Add properties for: slug generation, CSV
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
- **`test/scripts/stripe-mock/ports.test.ts` (~4s)** spawns real child processes
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

## Payment-processing review follow-ups (from PR #1692)

Both items describe behaviour that predates the payment-processing split (the
code was moved verbatim from the old `payment-processing.ts` monolith). They are
recorded here because the split PR was a pure reorganisation — changing this
behaviour there would be out of scope — and CodeRabbit flagged them as worth a
look.

- **Per-item DB reads not batched** (`src/features/api/payment-processing/items.ts`
  `validateAllItems`, and `package-pricing.ts` `loadPackagePricingByGroup`).
  `validateAllItems` calls `getListingWithCount` once per item in a loop, and
  `loadPackagePricingByGroup` makes two sequential round-trips per group. Under
  the edge subrequest budget these accumulate for larger orders. Fix direction:
  add/use a batched `getListingsWithCount(ids)` for all order listing ids at once
  and group the package-pricing loads, preserving the existing validation and
  fail-closed behaviour. See the "Respect the subrequest budget" guidance in
  AGENTS.md.

## Request performance: consolidate AsyncLocalStorage scopes

`src/features/app/request.ts` enters eleven nested request scopes for locale, client
IP, request ID, request cache, query logging, flash, session memoization, iframe
mode, CSRF, saved form data, and settings auditing. Replace them with one typed
`RequestContext` in one `AsyncLocalStorage`; retain domain methods where they add
behavior, but migrate every internal caller with no aliases or compatibility
wrappers. Preserve direct-render test behavior, production-disabled audit cost,
and concurrent/nested request isolation for every mutable field. Pending work
and storage overrides have different lifetimes and need a separate decision.
Benchmark before and after: the synthetic result was about 38us/request for
eleven scopes versus 2us for one. This needs a dedicated PR because it crosses
eleven state modules and their concurrency contracts.

## Dead-export scanner matches raw text (from PR #1745 review)

`test/scripts/code-quality/detectors.ts` scans raw file contents when deciding
whether an export is used (`IMPORT_CLAUSES` → `isSymbolImported` /
`importedSymbolsOf`, and `isUsedInSameFile`). A clause-shaped snippet inside a
comment, JSDoc, or string literal therefore registers a phantom "usage" — a
CodeRabbit review on PR #1745 pointed out a JSDoc example in that very file
doing this (fixed by rewording the comment), and the fixture strings in
`detectors.test.ts` still contribute contrived names like `routeFoo` to the
test-corpus symbol set. Consequences are mild today: a phantom symbol in the
src corpus can silently mask a genuinely dead export of the same name; one in
the test corpus can only make an export look test-used (which then flags it,
loudly). This is a long-standing property of the whole detector file, not new
to the dynamic-import clauses.

Proposed fix (the reviewer suggested syntax-aware parsing): a code-only
preprocessing pass before matching. The file already has the pieces — the
call-site scanner's `skipString`/`skipComment` lexer helpers skip comments and
string literals correctly. The pass must drop BOTH comments and ordinary
string/template-literal contents from the matchable text (a fixture string
containing `import { foo }` is exactly the stated failure mode), while still
letting the lazyExport clause see its quoted name — lazyExport names live
INSIDE a string literal (`…, "routeAdmin")`), so either match the lazyExport
shape before stripping and stitch its names in, or blank string contents
except when the lexer sees the string directly in lazyExport's second-argument
position. Add regression coverage for import-shaped text in a line comment, a
JSDoc block, and an ordinary string/template literal, plus a lazyExport entry
that must still be detected after the pass. Out of scope for
PR #1745 (cold-start work; the detector change there was collateral hardening)
— the concrete self-match it introduced was fixed in-place instead.

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

---

## Code-quality detector & test-strengthening follow-ups (from PR #1729)

*Origin: CodeRabbit review of PR #1729, deferred as out of scope for that
complexity-only refactor (which had to preserve behavior). All of these are
pre-existing behaviors carried over unchanged from `main`, not regressions.*

### 1. `skipTemplateSubstitution` should skip comment contents

`test/scripts/code-quality/detectors.ts` — the template-substitution scanner tracks
brace depth but does not skip comments, so a `}` inside a comment inside a
`${...}` prematurely closes the substitution; a later nested backtick can then
end the outer template early and leak commas into `parseArgList`. Repro shape:
`` `${/* } */ `x,y`}` ``.

Fix direction: within the depth loop, skip line/block comments (a `skipComment`
helper) before the brace-depth checks, and add a direct regression test for the
comment-with-`}`-then-nested-template case asserting `parseArgList` doesn't
misinterpret the comma.

## Restrictions audit — "why can't I combine X with Y?" follow-ups

*Origin: an audit of every place the app refuses a combination a user might
expect to work, aimed at cutting "why can't I select this?" support queries.
Each restriction was judged on whether its reason is genuinely insurmountable
(structure, money-correctness, capacity, privacy, security) or a soft limit
worth relaxing. The clearest informative wins already shipped — the package
"which listing and why" messages, the daily-add-on "needs a date" reason, the
payment-provider "your other key is kept" note, and the free-text "can't set a
price" note. What's left is captured below, split into rule-relaxations (let
the combination through) and message/UX fixes (keep the rule, stop the user
hitting it blind). All are pre-existing behaviour — deliberate design choices,
except the percentage-surcharge cap noted below, which is a latent correctness
bug (harmless today because of the multiplier workaround).*

### Keep the rule — stop the user hitting it blind

- ~~**SumUp is offered on a currency it can't use.**~~ **Done.** The provider
  registry (`src/shared/payment-providers.ts`) now records each provider's
  currencies (`null` = takes them all), and `providerCurrencyBlock(id, currency)`
  turns that into the one sentence every surface shows. The settings page renders
  an unusable provider switched off with the reason beside it, the provider
  choice refuses to save, and the SumUp credentials save keeps its refusal.

- **An answer's price-modifier dropdown silently omits the operator's modifier.**
  `src/features/admin/questions.ts` (`answerTriggerModifiers`) only lists
  `trigger === "answer"` modifiers, so a "+£5" built as *Automatic* or an add-on
  never appears and reads as a bug. Fix: add a hint by the selector (in the
  answers UI, `src/ui/templates/admin/questions.tsx`) — "only answer-triggered
  modifiers appear here; create one on the Modifiers page."

- **Group-homogeneity messages are hardcoded English and terse.**
  `groupListingTypeError` (`src/shared/db/groups.ts`) returns raw strings ("This
  group already contains … listings — all listings in a group must be the same
  type"), so they bypass the `I18N_REPLACEMENTS` rebranding pass and never say
  *why*. Fix: move them into `src/locales/en/*.json`, add the reason (the group
  shows one shared date/day-count selector, so members must match), and ideally
  grey out incompatible listings in the add-listings picker rather than erroring
  on save. Same treatment for the hardcoded "Customisable days cannot be combined
  with Allow Pay More" in `src/shared/listings-actions.ts`.

- **Two save-time either/ors would be clearer as disabled controls.**
  (a) customisable-days vs Allow Pay More (`validateCustomisableDays`,
  `src/shared/listings-actions.ts`) — the two fields sit in different form
  sections, so the operator never sees them as related; (b) a paid-default status
  that is also a reservation (`src/features/admin/settings-statuses.ts` ~line 69)
  — both checkboxes render side by side. Fix: mutually disable the paired
  controls client-side with a one-line "why", turning a save-time error into an
  obvious affordance.

- **"Refund processed but not recorded" reads like a failure.**
  `src/shared/refund-ledger.ts` only auto-reverses a fully-paid clean account; on
  a partial/credit/mixed account the provider refund fires but the operator sees
  `error.refund_not_recorded` ("do not re-refund") with no next step. Fix: link
  the manual-adjustment page straight from that flash and frame it as "one more
  step", not an error.

- **A multi-item cart with no shared date/length dies silently.**
  `dayCountsEveryListingSupports` / `computeSharedDates` (`src/shared/booking/
  model.ts`, `src/features/public/ticket-payment.ts`) leave the buyer with a bare
  "No dates/booking lengths are currently available" when two items simply share
  no common date or duration — undiagnosable mid-checkout. Fix: detect the
  empty-intersection case and name the conflicting items ("these don't share a
  common date — book them separately"). Highest buyer-facing value.

- **A manager hits a bare "Forbidden" on owner-only pages.** `src/features/
  auth.ts` (~line 462) returns plain text for users/statuses/bulk-email/settings.
  Fix: ensure the nav hides these for managers (the "never render a forbidden
  link" rule) and give the 403 an "owner-only" hint.

- **A child's duration mismatch with its parent is invisible until you open both
  day-price tables.** `children_err_child_duration` / `durationsCompatible`
  (`src/shared/listing-parents-rules.ts`) states the rule but not the clash. Fix:
  surface the actual mismatch at save time ("parent offers 2–3 days; this child
  prices only 1").

- **The order gallery advertises availability it can't honour** once required
  children fold in — already tracked above under *Booking unification →
  "`/order` live availability: fold required-child demand into options"*. Same
  fix; cross-referenced here because it's the buyer-facing half of this audit.

### Relax the rule — let the combination through

- **Only one payment provider active at a time.** `getActivePaymentProvider`
  (`src/shared/payments.ts`) reads a single `payment_provider` setting. This is
  *not* forced by the webhook — `getWebhookSignatureHeader` already scans every
  provider's signature header — so the block is the single scalar plus no
  per-order provider choice. Relaxing needs checkout-time provider selection,
  header-based webhook dispatch, and a multi-select UI. Reasonable to leave for a
  single-merchant site; revisit if operators ask.

- **A status in use by attendees can't be deleted, with no way out.**
  `src/features/admin/settings-statuses.ts` (~lines 200–221) blocks the delete
  outright. Fix: add a "reassign these N attendees to <status>, then delete" flow
  (the same move already used to retire a default status).

- **The embed widget refuses to add a package to the cart.** `src/ui/client/
  order.ts` (~line 489) force-navigates away from a package ("it could never
  combine with other listings"), but the internal cart (`src/features/public/
  cart.ts`) *does* combine packages with listings. Fix: add the package slug to
  the running cart and build a multi-slug `/ticket/<slug>+<slug>` URL like the
  internal gallery.

- **An answer can trigger only one modifier.** `answers.modifier_id` is a scalar
  (`src/shared/db/questions/aggregates.ts`). Everything downstream already handles
  arbitrary modifier sets; only the link is one-to-one. Fix: an `answer_modifiers`
  join table. Low frequency; do on demand.

- **A package can't contain a pay-what-you-want listing.** `packageMemberBlock`
  (`src/shared/package-membership.ts`) blocks it because a package needs a fixed
  member price. Relaxable if you define bundle pricing for a pay-more member (use
  its base price, or let the buyer choose within the bundle) — a semantics
  decision, not a structural wall.

- **A manager can't edit the public site, but a lower-trust editor can.**
  `SITE_ADMIN_LEVELS` (`src/shared/types.ts` ~line 556) is `["owner","editor"]`
  by history. Add `manager` if desired — a pure policy call.

- **Two-level listing nesting (A→B, then B→C).** `childEdgeIneligibility`
  (`src/features/admin/listings-parents.ts`) caps nesting at one level; the
  booking fold-tree and `capacity-rules.ts` both assume exactly parent+child.
  Real work (recursive fold + capacity), not a toggle — build only when a concrete
  booking needs it. (See also the booking-unification phases above.)

- **Child-scoped opt-in add-ons.** An add-on reachable only through a folded-in
  child is blocked because "v1 has no child-scoped add-on render/parse path"
  (`src/features/admin/listings-parents.ts`, `modifier-resolve.ts`). The
  `bookable_alone` flag is the current escape hatch; the real fix is to build that
  render/parse path.

- **The same pay-what-you-want add-on under two parents must share one price.**
  `foldChild` (`src/shared/booking/fold-tree.ts` ~line 281) keys the custom-price
  map by listing id. Per-allocation pricing would allow different prices; niche,
  do on demand.

---

## Design note: a shared "reasons" shape for validation failures

*Origin: reviewing the package-restriction work (PR #1770). The recurring shape
is "reject if any of N reasons holds, tell the user WHICH, sometimes list ALL"
— e.g. `packageMemberBlock`, `packageChildEdgeConflict`, `groupListingTypeError`,
the listing-input `?? next` chain. Worth writing down where this could go before
it sprawls into an over-built framework.*

**What already exists (don't rebuild it):**
- **i18n keys ARE de-facto error codes.** ~113 `error.*` keys in
  `src/locales/en/errors.json` are stable machine identifiers already decoupled
  from any one rendering. A "new error-code system" would mostly re-label these.
- **Declarative first-match rule tables** already appear twice:
  `EDGE_ERROR_RULES` (`src/shared/listing-parents-rules.ts` — a
  `readonly EdgeRule[]` matched with `.find(r => r.rejects(a,b))?.error(...)`)
  and `CAPACITY_RULES` (`src/shared/capacity-rules.ts`). `packageMemberBlock`
  (this PR) is a third, hand-rolled instance of the same idea.
- **Sentry is for the *unexpected* only.** Validation failures never reach it
  today, which is correct — an operator picking an invalid combo is not a bug,
  and routing every "you can't do that" to Sentry would bury real incidents.

**What a slick version is — and, honestly, mostly ISN'T worth building here:**
- **NOT worth it:** a global error-code registry/enum, per-code guide deep-links,
  or converting every fail-fast validator to collect-all. That is a large
  cross-cutting refactor whose value this app's size doesn't justify, and
  collect-all is often *worse* UX (fix-one-resubmit beats a wall of ten errors).
  Fail-fast is a feature, not a limitation, for most forms.
- **Worth it, but only when a real need pulls it (do not do speculatively):**
  1. **One `reasons` combinator.** A tiny `Rule<T> = { code; when(x): boolean;
     message(x): string }` list with two runners — `firstReason(rules)(x)` and
     `allReasons(rules)(x)` — so a call site picks fail-fast vs list-everything
     from ONE rule definition. `EDGE_ERROR_RULES`/`CAPACITY_RULES`/
     `packageMemberBlock` would converge on it. Extract on the *third* real
     collect-all need, not before (two tables sharing a shape is not yet a
     framework).
  2. **A `kind` on each error: `user_error` vs `invariant_violation`.** This is
     the one with actual operational payoff and it's small. Most `error.*` keys
     are `user_error` (stay out of Sentry). A handful are "should never happen,
     an operator must act" — `error.refund_not_recorded` (refunded at the
     provider but not recorded in the ledger — `attendee-refunds.ts`,
     `attendees-edit.ts`) is the exemplar. Tag those `invariant_violation` and
     route only them to Sentry (breadcrumb + alert), so the money-integrity
     cases surface without drowning in expected validation noise.

**Recommended first step, if any:** just the `kind` tag on the ~2-3 invariant
errors + a single Sentry breadcrumb at the flash boundary. Skip the combinator
until a real collect-all site (e.g. the multi-item-checkout "no shared date"
diagnostic above) makes it pay for itself.

## Deferred CodeRabbit suggestions from PR #1772 (servicing test relocation)

*Origin: CodeRabbit review of PR #1772, which only `git mv`s the servicing
db-module tests into `test/shared/db/attendees/servicing/` (plus a 4-line cwd
fix in `code-quality.test.ts`). CodeRabbit reviewed the moved content as if new
and raised 13 findings; every one is on **pre-existing** test code carried over
unchanged from `main`, so they were out of scope for a rename-only PR and
recorded here.*

**Done — the two vacuous tests + the corruption-repair cleanups (a follow-up
PR).** Both suspects were confirmed and fixed:

- `corruption-repair.test.ts` — the `UPDATE … kind = 'staff'` did throw under the
  CHECK and was swallowed by `catch { return }`, so the exclusion assertions
  never ran (confirmed empirically). Now the corrupt row is written past the
  CHECK via `PRAGMA ignore_check_constraints` (libsql supports it), so the reader
  predicates are genuinely exercised — and a separate test asserts the CHECK
  rejects the write directly. The dead `queryOne` import, the `string | null`
  param on `insertRowWithKind`, and the redundant dynamic imports were removed.
- `lifecycle-concurrency.test.ts` (~87-110) — the raw SQL deletes were replaced
  with the production `deleteListing`, and the orphan assertion strengthened
  (attendee row survives; its booking on the deleted listing is gone).

**Done — assertion-strengthening in
`test/shared/db/attendees/servicing/ledger.test.ts` (a follow-up PR).** All
seven were applied: `expectCostFormError` now asserts an error flash and that no
leg of any kind was posted (total-transfer snapshot); idempotency keys are fixed
strings, not `crypto.randomUUID()`; the memo-only replay test asserts the error
flash; the `recordServiceCost` replay test asserts the exact
`COST_REPLAY_MISMATCH` message (via `expectRejects` now accepting an exact
string); the ordering test seeds a same-`occurredAt` pair to exercise the
`(occurred_at, transfer_id)` tie-break; the encrypted-memo test asserts the full
plaintext memo is absent; and the `visibleTransfers` filter test adds a second
listing and asserts the result is scoped to the requested listing.

**Done — split the file (a follow-up PR).** The 826-line `ledger.test.ts` was
split into five focused files under `test/shared/db/attendees/servicing/`
(`ledger-accounts`, `ledger-idempotency`, `ledger-cost-editing`,
`ledger-validation`, `ledger-reader`), each well under 400 lines. The shared
fixtures (`recordBoilerCost`, `postCustomerSale`, `listingProfitOf`,
`expectCostFormError`, `transfersOfKind`, `SERVICE_DATE`) moved to a new
`#test-utils/servicing-ledger.ts`, and the generic non-empty flash assertions
(`expectFlashError`/`expectFlashSuccess`) moved to `#test-utils/assertions.ts`
next to `parseFlashCookie`. A pure reorganisation — the same 40 tests run, no
test behaviour changed.

*Nothing remains open in this section.*

## Logistics run sheet — should servicing events appear?

`getAttendeesByIds` (in `src/shared/db/attendees/queries.ts`) filters to
`kind: "attendee"` — the exact behaviour the pre-existing query had before the
attendee-read centralisation (PR #1790). Its only caller is the logistics run
sheet (`src/features/admin/deliveries.ts` → `loadLegLookups`), so servicing
events (`kind = "servicing"`) never show there.

A reviewer (CodeRabbit on #1790) suggested making the lookup kind-agnostic so
servicing rows with logistics agents would appear on the run sheet. That is a
product/behaviour change, not a refactor, so it was left out of #1790. If
servicing events are meant to carry delivery legs and appear on the run sheet,
drop the `kind` filter on that read (pass `kind: "attendee-or-servicing"`) and
add a run-sheet test that a servicing event with agents shows up. If they are
correctly excluded, no change is needed — this note just records that the
exclusion is deliberate, not accidental.

---

## Test suite speed — remaining tail work

*Origin: the test-suite performance PR (grouped isolates + run-scoped test
state).*

The full runner now shares isolates between test files
(`scripts/test-groups.ts`) and prebuilds the DB setup state once per run
(`test/test-utils/test-state.ts`). The remaining wall-clock tail is a handful
of genuinely long suites, which now bound the slowest groups:

- **Migration chain shards** (`test/integration/db/migration-restore/`, ~20s each ×4
  shards). They already shard by `index % shardCount`; raising the shard count
  (4 → 8) would halve each shard and shorten the tail groups. Purely
  mechanical — the factory takes the count.
- **Slow-test report entries >2s** (printed after every full run): the
  migration/legacy-migration suites and a few e2e journeys dominate. Each one
  fixed shortens the longest group directly.

Starting point: run `deno task test`, read the slow-test report at the end,
and profile the top entry.

## Split the admin questions template test file

*Origin: review of PR #1796 (the `[object Object]` error-box fix). Flagged by
CodeRabbit while that PR hardened the questions template's mutation coverage.*

`test/ui/templates/admin/questions.test.ts` is ~876 lines — over the ~400-line
target for test files (it was already ~795 before #1796 added the hardening
assertions; it stays under Biome's 1,000-line hard limit, so it is not
grandfathered and CI passes). Smaller, focused test files also let mutation
runs map `questions.tsx` to a narrower suite.

Split it into focused sibling suites sharing one fixtures helper, roughly:
- `questions-list.test.ts` — `adminQuestionsPage` (the reorderable list).
- `questions-detail.test.ts` — `adminQuestionPage` + `ListingQuestionsPanel`.
- `questions-answer.test.ts` — `adminAnswerEditPage` / `adminAnswerRecalculatePage`.
- `questions-delete.test.ts` — `adminQuestionDeletePage` / `adminAnswerDeletePage`.

Extract the shared fixtures (`colourQuestion`, `TEST_LISTINGS`, `TEST_SESSION`,
the answer/question factories) into a local helper the suites import, and keep
`questionTextFlat` + `buildAnswerSummaryRows` with whichever suite reads most
naturally. Preserve every existing assertion — behaviour must not change. The
attribute template test (`attributes.test.tsx`) is the shape to mirror.

## Pre-existing issues surfaced during the min-tokens-20 dedup (PR #1795)

CodeRabbit flagged these while reviewing the dedup PR. Each is a real point but
pre-existing (the dedup preserved the behaviour, it did not introduce it), so
they were left out of that PR's scope.

- **Bulk email draft cleared after the send, not before**
  (`src/features/admin/bulk-email.ts`, the `sendBulkEmails → recordContacts →
  bulkEmailDraft("") → logActivity` sequence). `sendBulkEmails` is
  non-idempotent, so if `recordContacts` throws after the send, a retry can
  resend to the whole audience. Moving the draft-clear before the send trades
  that for the opposite risk (a failed send loses the draft with no retry), so
  it needs a deliberate decision — likely a "draft consumed" marker distinct
  from "draft empty". Not a dedup regression: the ordering is byte-identical to
  before the PR.

- **Tautological admin-API example test**
  (`test/shared/admin-api-example.test.ts`: `toAdminListing output matches the
  documented example`). `ADMIN_API_EXAMPLE_ADMIN_LISTING` is defined as
  `toAdminListing(API_EXAMPLE_LISTING)` and the test compares
  `toAdminListing(API_EXAMPLE_LISTING)` against it — both sides derive from the
  same call, so the assertion cannot catch a `toAdminListing` shape regression.
  Fix: author an independent `AdminListing` fixture (or assert against an
  admin-listing schema). Pre-existing — the base had the same tautology via the
  now-removed `ADMIN_API_EXAMPLE_LISTING` alias.

- **Bulk-group-duplicate form loses inputs on a failed POST**
  (`src/ui/templates/admin/bulk-actions.tsx` `adminDuplicateGroupPage`). On a
  validation error the form re-renders with defaults (`${group.name} (copy)`,
  blank find/replace/date) instead of the submitted values. Pre-existing: the
  page's `values` param was already unused before this branch (this dedup only
  deleted the dead param), so the form has never re-filled on error. Fix: thread
  the submitted values back into the `TextField`/`TextFields` inputs, following
  the flash/form-refill pattern other admin forms use.

- **Attempt-lockout expired-row cleanup is not TOCTOU-safe**
  (`src/shared/db/attempt-lockout.ts` `lockoutActive`). The expired-row delete is
  unconditional, so a request that observes an expired lockout can delete a fresh
  lockout another request wrote in between, losing rate-limit state for that IP.
  Pre-existing: the two attempt tables (`login_attempts`, `token_attempts`) both
  deleted unconditionally before this branch merged them into one helper. Fix:
  make the delete conditional on the stored `locked_until` still equalling the
  observed value, in one atomic statement.

- **`deployAndReport` lets an activity-log failure mask a successful deploy**
  (`src/shared/site-update.ts`). Only the deploy runs inside `tryStep`; the
  `logActivity` write after it is not, so a transient log-write failure throws
  out of `deployAndReport` as a raw 500 even though the deploy succeeded (before
  this dedup each route's own try/catch returned its normal error page). The
  right fix is to make the activity-log write best-effort — a successful deploy
  should return success even if the log line can't be written — with a
  regression test that stubs `logActivity` to reject. Introduced by folding the
  two update routes onto the shared helper.

- **Update success/log copy is hardcoded, not in the catalog**
  (`src/shared/site-update.ts` `deployAndReport`, fed by
  `src/features/admin/update.ts` and `built-sites.ts`). The success flash
  (`"${successPrefix} to ${name} — the new version will be active shortly"`) and
  the activity-log line (`"${logPrefix} to ${name} (${tag})"`) are built from
  hardcoded `successPrefix`/`logPrefix`/tail strings rather than `t()` keys. This
  copy is byte-identical to what lived in `update.ts` on `main` before the dedup
  (the flash string `"Updated to … — the new version will be active shortly"` was
  already there); the dedup only moved it into the shared helper. Fix: add ICU
  keys with `{name}`/`{version}` placeholders and pass the two call sites' prefix
  choices as keyed variants, so the flash and log line read from the catalog.
  Out of scope for a dedup PR (pre-existing copy, not a new string).

- **Admin API docs prose is hardcoded, not in the catalog**
  (`src/ui/templates/admin/api-keys.tsx` — the authentication intro
  `"Admin API endpoints require authentication…"`, the `"Public API endpoints
  require no authentication. All responses are JSON."` line, the admin-group
  intro `"Requires <code>Authorization: Bearer YOUR_API_KEY</code> header."`, and
  the `"Use it with: <code>…</code>"` copy-notice line). These are all present
  unchanged on `main` — the dedup restructured the page onto `DocsSection`/
  `sectionsRenderer` but did not touch the wording. Developer-facing API-doc copy
  may keep literal technical terms, but the surrounding prose still belongs in
  `src/locales/en/*.json` (the sibling `api_keys.public_api_note` already is a
  catalog key). Fix: add `api_keys.*` keys for the four strings, rendering the
  `<code>`-bearing ones via `Raw`. Out of scope for a dedup PR (pre-existing
  copy).

- **The `/api/*/book` docs show a free response for a priced sample**
  (`src/shared/admin-api-example.ts`). Both `POST /api/listings/:slug/book` and
  `POST /api/packages/:slug/book` document their response as
  `API_BOOK_FREE_EXAMPLE_JSON` (`amountOwed: 0`, a ticket token), even though the
  package sample request is a priced bundle whose real response would carry a
  `checkoutUrl` (`API_BOOK_PAID_EXAMPLE_JSON` already exists). Pre-existing: on
  `main` both endpoints used a local `API_EXAMPLE_BOOKING_RESPONSE` const that is
  byte-identical to `API_BOOK_FREE_EXAMPLE_JSON`, and this dedup only merged that
  duplicate into the shared constant — it did not change which example shows. Fix
  (a doc-accuracy pass, not a dedup): pick the example per endpoint — a paid
  response for the priced package bundle, or document both free and paid shapes —
  so the sample response matches the sample request.

## Placeholder refund — replay marker gap when the atomic ledger batch fails

*Origin: Codex review on PR #1822 (atomic placeholder payment + refund ledger).*

`recordPlaceholderRefund` (`src/shared/refund-ledger.ts`) posts the payment
and completed-refund legs as one atomic `postTransferGroups` batch, so a
refund-leg conflict rolls the payment back too (the PR's core requirement).
When that batch fails outright, NO ledger legs land for the booking event
group. The payment flow's durable replay guard is the ledger preflight
(`replaySessionFromLedger` → `bookingLedgerDisposition`: `unrecorded` when
no legs exist), and the primary guard (`markSessionFailed`'s `failure_data`
row) is pruned by `prunePayments` once it ages past retention. So after
pruning, a late webhook/redirect for the same already-refunded session
re-enters `processReservedSession`, sees `unrecorded`, and re-creates a
placeholder attendee + re-calls `tryRefund` (idempotent, so no double payout)
instead of acknowledging the session as already handled.

This is NOT fully new: on main before PR #1822 the same gap existed for a
payment-post failure (the first `postTransfers` threw → no legs). PR #1822
widens the failure surface from "payment-post failure only" to "payment-post
OR refund-post failure" (because both are now one atomic batch). Closing it
properly needs a durable handled marker that survives idempotency-row pruning
without breaking the atomic rollback — e.g. a ledger leg that survives even
when the refund leg conflicts (which would violate #1822's acceptance
criterion: "a refund-reference collision proves neither transfer group is
committed"), or a separate replay-state row outside the prunable
`processed_payments` table. The staged-checkout runtime (deferred
foundations item 6 in `PR_SPLIT_PLAN.md`) carries the proper replay/activation
machinery to resolve this. Starting point: the preflight in
`src/features/api/payment-processing/index.ts` (`replaySessionFromLedger`),
the pruner in `src/shared/db/prune.ts` (`prunePayments`), and the
classification in `src/shared/session-ledger.ts`.

## Stripe webhook setup hardening — deferred edges (from PR #1827)

*Origin: CodeRabbit and Codex review of PR #1827 (the same-URL cleanup +
atomic credentials + shared URL helper PR). The create-first refactor and
endpoint-limit fallback were applied in that PR; the one edge below was
judged out of scope and recorded here.*

`setupWebhookEndpointImpl` in `src/shared/stripe.ts` creates the new endpoint
only — old same-URL endpoints are deleted by a separate
`cleanupOldWebhookEndpoints` call that the settings route invokes AFTER
`settings.update.stripe.webhookConfig` saves the new endpoint ID + secret to
the DB. This ordering ensures a DB-save failure leaves the old endpoint
(whose secret matches the DB) in place. If Stripe rejects the create because
the account is at its webhook-endpoint cap, setup deletes same-URL strays
(keeping the recorded endpoint intact) and retries the create. One edge
remains:

- **Same-URL stray listing doesn't paginate.** `fetchWebhookEndpoints` calls
  `client.webhookEndpoints.list({ limit: 100 })` once and returns `.data`
  without following Stripe's `has_more` cursor. A site that has accumulated
  more than 100 webhook endpoints (rare — would require many failed setups
  or a long-running test environment) would leave strays beyond the first
  page un-deleted. Impact is limited: the new endpoint is already live and
  the DB points at it, so leftover strays are duplicate-delivery-only, not
  a signing-secret mismatch. Fix direction: follow the `has_more`/cursor
  loop in `fetchWebhookEndpoints` so the same-URL filter sees every
  endpoint. Starting point: `src/shared/stripe.ts` (`fetchWebhookEndpoints`
  and `listSameUrlEndpointIds`).

---

## Bunny subrequest budget follow-ups

*Origin: request-fan-out audit for PR #1820.*

Bunny stops an edge request after 50 subrequests. PR #1820 adds a request-scoped
database guard that blocks libsql call 51 and fixes the concrete failures found
in fresh setup, group duplication, ordinary backups, reset/restore, and bulk
refunds. The paths below still have data-dependent fan-out. The guard makes the
database-only cases fail loudly, but it cannot count provider or storage calls.

- **Package carts and payment completion.** `resolveCartSlugs` and
  `handleCartBySlugs` in `src/features/public/cart.ts` do four package reads per
  slug, so 13 packages can make 52 calls. `loadPackagePricingByGroup` in
  `src/features/api/payment-processing/package-pricing.ts` does three reads per
  group, so 17 groups can make 51. `getPackageDisplaysByIds` in
  `src/shared/db/groups.ts` also reads displays one group at a time. Batch group
  resolution, member/day prices, and displays for all package ids.
- **Registration logs and outgoing webhooks.** `logAndNotifyRegistration` and
  `sendRegistrationWebhooks` in `src/shared/webhook.ts` can insert one activity
  row per booking, load two overrides per package, and fetch every distinct
  webhook URL. Add one bulk log insert and one batched override read. Persist
  outbound webhook jobs for bounded out-of-band delivery.
- **Multi-entry check-in.** `handleCheckinPost` in
  `src/features/checkin.ts` calls `updateCheckedIn` once per eligible booking
  line. A token set with 51 lines therefore makes 51 updates. Replace it with
  one set-based update over all attendee/listing pairs.
- **Order availability by duration.** `poolBySpan`, `remainingBySpan`, and
  `groupRemainingBySpan` in `src/features/public/order.ts` run six capacity
  reads per distinct duration/group combination; nine distinct durations can
  make 54 calls. Load one capacity snapshot for the widest span and derive each
  duration in memory.
- **Automatic built-site assignment.** `assignSitesForEntries` and
  `assignSiteWithRenewal` in `src/shared/site-assignment.ts` mix per-unit DB
  writes with provider calls. Eleven Deno site units, or nine Bunny site units,
  can exceed 50. Reserve assignments in one batch, queue provider provisioning,
  and batch-persist the successful renewal states.
- **Old database migration.** `runPendingMigrations` in
  `src/shared/db/migrations.ts` uses at least two marker calls per migration;
  25 pending migrations exceed the limit before their own work.
  `applySchemaChanges` in `src/shared/db/migrations/schema-sync.ts` also runs
  each missing-column ALTER separately. Move long migrations out of band or
  make progress resumable in bounded request-sized steps, and batch safe ALTERs.
- **Large in-app backups and storage cleanup.** After the first-page batch,
  `exportTable` in `src/shared/db/backup-snapshot.ts` still needs one call per
  later page; a 25,000-row table at the default page size needs about 50 pages
  by itself.
  `cleanupStalePendingFiles` in `src/features/admin/backup.ts` and
  `pruneOldBackups` make one storage delete per stale object. Send large backups
  through the existing out-of-band workflow and cap cleanup work per request.
- **Bulk email.** `sendBulkEmails` in `src/shared/email.ts` can create more than
  50 provider batches for very large audiences. Queue bulk sends out of band or
  stop at a fixed aggregate request budget and resume the remainder later.
- **Attendee CSV export.** `allAttendeeBookings` in
  `src/features/admin/attendees-list.ts` reads 100 attendees per page; 5,001
  matches need 51 calls. Generate large exports out of band and give the
  synchronous route a strict cap.
- **Admin seed generation.** `createSeeds` in `src/shared/seeds.ts` uses one
  attendee batch per 50 rows; 2,501 attendees exceed 50 calls, while the form
  permits far more. Move seed generation to CLI/background work or cap the
  total from the request budget.
- **Remaining group admin reads.** `validateListingTypesForGroup` in
  `src/features/admin/groups.ts` reloads siblings per listing, and
  `loadGroupContext` in `src/features/admin/listings-view.ts` loads each group
  and capacity separately. Load siblings once and batch all group/capacity rows.

The `scripts/backup.ts` command and fleet loops in GitHub Actions run outside
Bunny and are not subject to this per-request limit. Restore replay and catalog
import already use bounded batches.

---

## Resumable paid-booking completion

*Origin: CodeRabbit review of PR #1833.*

The attendee, booking rows, ledger, modifier use, contact activity, and payment
finalization commit atomically, but `completePaidBooking` then saves answers,
logs promo-code use, and calls `logAndNotifyRegistration` after that commit. If
one of those effects fails, `processed_payments.attendee_id` already marks the
session as finished. A later webhook or redirect therefore replays success
without retrying the unfinished work. This gap predates PR #1833, but that PR
made the boundary easier to see. It deliberately excludes schema changes, so a
durable completion system is outside that atomic-write-only change.

Build one resumable completion mechanism rather than retrying these calls ad
hoc. Store the completion input and per-effect state against the payment session
in the same transaction that finalizes the booking. Claim unfinished effects
with a stale lease so racing webhook and redirect requests cannot both run them.
Make each database effect and its completed marker one transaction. Give
external deliveries a stable idempotency key where the provider supports one,
and do not prune payment rows with unfinished work. Fresh completion,
lost-result recovery, processed-payment replay, and ledger replay must all call
the same resume function.

Starting points: `src/features/api/payment-processing/completion.ts`,
`src/features/api/payment-processing/index.ts`,
`src/shared/db/payment-finalize.ts`, `src/shared/db/processed-payments.ts`,
`src/shared/db/prune.ts`, `src/shared/webhook.ts`, `src/shared/email.ts`, and
`src/shared/site-assignment.ts`. Tests must interrupt each effect, retry through
both webhook and redirect paths, and prove answers, activity, messages, site
assignments, and renewal time are neither lost nor duplicated.

---

## Consistent database backup snapshots

*Origin: CodeRabbit review of PR #1836.*

`createBackup` batches each table's first page, then `exportTable` reads later
pages with standalone queries. A write during those reads can make a backup mix
rows from different database states. PR #1836 only moves the existing exporter
into `src/shared/db/backup-snapshot.ts`; it deliberately preserves the current
queries, replica routing, pagination, and round-trip behavior.

Add a dedicated read-only transaction or snapshot API in
`src/shared/db/client.ts`. Do not reuse `withTransaction`: that helper opens a
primary-routed write transaction, serializes writers, and enforces a write
round-trip limit. Keep the first-page multi-table read efficient, account for
the edge subrequest budget, and use the same snapshot for every later page.
Add a regression test in `test/shared/db/backup-snapshot.test.ts` that changes
rows between page reads and proves the exported rows all come from one database
state.

---

## Backup storage edge cases

*Origin: CodeRabbit review of PR #1837.*

PR #1837 only moves the existing backup storage helpers out of
`src/shared/db/backup.ts`; it deliberately preserves their behavior. These
possible behavior changes need separate decisions and regression tests:

- **Keep every database namespace non-empty and distinct.** `dbName` in
  `src/shared/db/backup-storage.ts` returns an empty name for a parseable local
  `file:` URL and strips the first dashed part from non-Bunny hostnames. Decide
  the supported URL schemes and hostnames, return a named local folder for local
  URLs, and only remove Bunny DB's UUID prefix for `.lite.bunnydb.net`. Start
  with tests for `file:database.db` and two distinct dashed HTTPS hostnames.
- **Reject future-dated backups from the update gate.** `hasRecentBackup` in
  `src/shared/db/backup-storage.ts` treats every future timestamp as recent
  because its age is negative. Decide how much clock skew is acceptable, then
  require a non-negative age (or a documented tolerance) before applying the
  maximum age. Add a test with a future backup filename.

---

## Checkout stage attendee cleanup

*Origin: Codex review of PR #1840.*

Before any runtime path writes `checkout_stages`, include those rows in attendee
deletion, purge, and merge handling. The table has no foreign key, so leaving
the current hard-coded dependent-table lists unchanged would keep a stage linked
to an attendee that no longer exists. Start with
`src/shared/db/attendees/delete.ts` and
`src/shared/merge/attendee-merge.ts`. Add direct regressions proving deletion
removes a stage and merging repoints it without losing the unique attendee
invariant. If both attendees have stages, require an explicit conflict decision
instead of silently choosing or deleting one.

---

## Test improvements surfaced by PR #1873 (move-only)

*Origin: CodeRabbit review of PR #1873 — "Move eight integration tests to
test/integration/". PR #1873 was a move-only refactor: files were relocated with
`git mv` and only relative import paths were updated. The four findings below are
about pre-existing test code that was already on `origin/main` before the move;
they are recorded here so a future PR can pick them up without re-reading the
review. Each item names the file/path, what CodeRabbit proposed, why it was out
of scope for #1873, and a starting point.*

- **Reuse shared `#test-utils` KEK helpers in `test/integration/kek-v2.test.ts`
  (lines 46–92).** `unwrapUserKey` and `ownerDataKey` repeat admin unwrap logic
  that may already live in `test/test-utils/{crypto.ts,session.ts,test-state.ts}`.
  A future PR should check whether a shared helper for "unwrap a v2 user's
  DATA_KEY with the per-user-salted password KEK" and "unwrap the shared owner
  DATA_KEY" already exists or should be extracted, then fold this file's local
  copies into it. Keep `seedV1User` local (it constructs a legacy-only fixture)
  and leave `sharesOwnerDataKey` as the spec-specific check. Start by searching
  `test/test-utils/` for `deriveKEKFromPassword`, `unwrapKey`, and
  `getUserByUsername` to see what is already shared.

- **Assert the required `LATEST_DB_UPDATE_KEY` row directly in
  `test/integration/migration-round-trip-budget.test.ts` (line 134).** The test
  uses `marker.rows[0]?.value` with optional chaining, so a missing marker row
  would fail with an unhelpful `undefined !== LATEST_UPDATE` rather than naming
  the missing row. A future PR should replace it with
  `expect(marker.rows.map(({ value }) => String(value))).toEqual([LATEST_UPDATE])`
  (or an equivalent that names the missing row) so the assertion fails loudly
  when the row is absent. This aligns with the offensive-programming rule
  against `?.` papering over a value that should always exist.

- **Assert the computed cutoff in
  `test/integration/renewals.test.ts` (lines 187–192).** The test is titled
  "pushReadOnlyFrom is called exactly once with computed cutoff" but only checks
  the call count via `expectReadOnlyFromPush(secretStub)`, discarding the
  returned `{ scriptId, secretValue }`. If the cutoff month math regresses, the
  test would still pass despite its name. A future PR should capture
  `secretValue` from `expectReadOnlyFromPush` and assert it equals
  `addMonthsIso(baseDate, 2)` (the expected quantity-2 cutoff) while keeping the
  exactly-once assertion. `baseDate` is already destructured from
  `withRenewalTest` in neighbouring tests.

- **Assert the error log in
  `test/integration/renewals.test.ts` (lines 204–210).** The test is titled
  "siteToken present but no matching site logs error, no Bunny call" but only
  asserts `expectNoBunnyCall(secretStub)` — the "logs error" half of the title is
  unverified. A future PR should add a `console.error` assertion using the
  existing error-spy helper (search `test/` for `spy(console, "error"` or an
  `errorSpy` helper) so the test verifies the error is emitted for the missing
  site-token match, or rename the test to drop the unverified claim. Start by
  reading `applyRenewalsForEntries` in `src/shared/webhook.ts` to confirm it
  calls `console.error` (or `logError`) on a missing site-token match.

- **Extract scanning helpers from `test/integration/code-quality.test.ts` into a
  focused module.** CodeRabbit suggested (PR #1872 review) pulling
  `forEachScannedFile`, `collectLineViolations`, `collectFileViolations`,
  `scanSourceLines`, `scanSourceFiles`, `ensureLoaded`, the `getAll*Files`
  helpers, `repoRelative`/`getRelativePath`/`isCodeQualityFile`, and the
  `SRC_DIR`/`TEST_DIR`/`SCRIPTS_DIR`/`CLI_DIR`/`E2E_PAYMENTS_DIR`/`REPO_ROOT`
  path constants out of the test file — they're file-discovery and scanning
  plumbing, not test assertions. The file is currently 699 lines (under the
  Biome 1,000-line hard ceiling but over the 400-line soft target). A
  `test/scripts/code-quality/scan-context.ts` module exporting `ScanContext`,
  `loadScanContext`, `collectLineViolations`, `collectFileViolations`, and
  the path constants would let the test file import them and keep only the
  assertions and per-rule config. Start from the file-discovery helpers
  already at the top of `code-quality.test.ts` (lines 295–360) and the
  `ensureLoaded`/`forEachScannedFile`/`collect*Violations`/`scanSource*`
  helpers inside the `describe("code quality", …)` block (lines 360–540).
  This is a structural refactor (no behavior change); add a regression test
  that re-runs the no-`../` rule against a fixture file via the extracted
  helpers to prove parity with the inline implementation.
---

## Admin debug test coverage follow-ups

*Origin: CodeRabbit review of PR #1875 ("Move admin debug tests and add a
template rendering test"). PR #1875 is test-only: it `git mv`s
`test/lib/server-debug*.test.ts` into `test/features/admin/debug/`, extracts
shared state into `test/test-utils/debug.ts`, and adds a direct-rendering test.
CodeRabbit raised two findings that are valid as code-quality observations but
out of scope for that PR's brief — recorded here for a follow-up.*

- **Inspect the Sentry test envelope, not only the request count.** In
  `test/features/admin/debug/sentry.test.ts` (around lines 63-68), the
  "sends a tagged test error and confirms delivery" test stubs `fetch` with the
  shared `stubFetch` helper and asserts only that one request was made. It does
  not prove the emitted event is tagged or carries the intended test-error
  message. Replace the shared stub with a local fetch recorder inside that test,
  then assert the captured Sentry envelope body contains the literal message
  `"Test Sentry notification from the admin debug page."` and the
  `source=admin-debug` / `test=true` tags (the literal values
  `src/shared/sentry.ts` `sendSentryTest` writes today — keep them in sync with
  that source when the follow-up lands). Retain the existing request-count,
  redirect, and flash assertions. Starting point: read `sendSentryTest` in
  `src/shared/sentry.ts` (lines ~74-101) to confirm the exact envelope values,
  then look at `test/test-utils/fetch-stub.ts` to see what the shared stub
  exposes today.
- **Assert semantic debug sections, not CSS-class counts.** In
  `test/ui/templates/admin/debug/rendering.test.tsx` (around lines 38-40), the
  "keeps the debug navigation and section structure" test asserts the page
  contains exactly 3 `class="prose"` and 13 `class="table-scroll"` occurrences.
  Those counts couple the test to presentation wrappers, so a layout change can
  fail it without changing page behaviour. PR #1875 carried these counts in
  because the brief explicitly asked for them as the current-main contract; a
  follow-up can replace them with assertions on the rendered section headings.
  Keep the `href="/admin/debug"` link assertion. Maintain the expected heading
  set as an explicit literal list inside the test (`t("debug.section.build")`,
  `t("debug.section.runtime")`, etc.) — do **not** derive it from
  `DEBUG_SECTIONS` in `src/ui/templates/admin/debug.tsx`: deriving the oracle
  from the same source list the template renders against lets a removed or
  renamed section pass undetected when both the rendering and the oracle shift
  in lockstep. An independent literal list makes a section addition/removal/rename
  a deliberate test review, which is the only way the test catches the failure
  mode it is meant to catch.

---

## Recover paid SumUp checkouts without a webhook or redirect

*Origin: follow-up to the SumUp provider work, surfaced 2026-07-25 while
documenting SumUp in `README.md` / `src/docs/payments.ts` (PR #1918).*

SumUp does not sign its webhooks. If its webhook is lost and the customer never
returns to the redirect URL, SumUp can charge the customer without creating a
booking or payment record. Only the staged checkout remains, and database
pruning removes it after 24 hours.

Add a bounded maintenance task to `src/shared/maintenance/registry.ts` that
checks a page of staged SumUp checkouts on each run. Fetch each checkout once.
When SumUp reports it as `PAID`, pass the fetched session through the same
classification and `processPaymentSession` path used by webhooks and redirects.
Extract a shared entry point that accepts an already fetched session so the task
does not make a second provider request. Keep each run within the edge request
budget and request a follow-up run when a full page remains. Add a regression
test that runs webhook, redirect, and maintenance attempts concurrently and
proves they create the attendee and ledger rows exactly once.

---

## Stale equivalent-mutant line numbers across recent refactors

*Origin: running `deno task mutation:audit-equivalents` while hardening
`src/shared/square.ts` for the confirmed-Square-refunds job.*

`scripts/mutation/equivalent-mutants.txt` carries several entries whose
`file:line:col` no longer points at a generated mutant, so
`deno task mutation:audit-equivalents` aborts with "No generated mutant matches".
The mutants are still real and equivalent; only the code moved. Confirmed stale
entries span at least:
- `src/shared/uptime-kuma/socket.ts` (lines 107, 130, 167, 187 — `===`/`!==`↔loose)
- `src/shared/uptime-kuma/monitors.ts` (lines 87, 101, 116, 119, 138, 193, 227,
  250, 306, 325 — `===`/`!==`↔loose and `1000→1001`)
- `src/shared/scheduled-access.ts:16:20 ??→||`
- `src/shared/storage.ts:376:18 application/octet-stream→""`
- `src/ui/templates/admin/images.tsx:84:28` and `:85:20 ??→||`
- `src/features/app/routes.ts:235:14 →"mutated"`

These most likely drifted when the Uptime Kuma modules were split into
one-concept-per-file (#1906) and other recent move/refactor PRs. The audit is a
standalone task (`mutation:audit-equivalents`, not part of `deno task
precommit`), so CI doesn't gate on it; it surfaced here only because the
Square-refunds job ran exhaustive mutation and used the audit to validate its
own equivalent entries. The `square.ts` entries in the equivalent-mutants
registry have been refreshed in place (they drift as the source shifts lines —
the audit command's own output lists every stale `file:line:col`);

Fix: for each stale entry, re-run `deno task mutation <file> '<tests>'
--exhaustive`, locate the surviving equivalent mutant's current `file:line:col`
from the report, and update the line/col in `equivalent-mutants.txt` (or remove
the entry if the static gates now kill it — `mutation:audit-equivalents --write`
does this automatically for entries the lint/type-check gates catch). Then
re-run the audit until it reports no stale entries. Starting point: the audit's
own output lists every stale `file:line:col`.

---

## Square PENDING refunds — propagate a pending result, not a plain false

*Origin: Codex review of PR #1911 (confirmed Square refund outcomes), thread
on `squareApi.refundPayment` (`src/shared/square.ts`). This PR deliberately
does NOT address it; recorded so the follow-on work can pick it up.*

`squareApi.refundPayment` returns `false` for a Square refund that is still
`PENDING` (an accepted-but-unsettled refund). That is the honest current-main
boolean contract this PR ships, but it has a real downstream cost the reviewer
flagged: the webhook/admin refund flow reads `refunded === false` as a failed
refund, so a pending Square refund releases the reservation, returns 503, and
— because each call mints a fresh `crypto.randomUUID()` idempotency key — a
redelivery posts another full-refund attempt instead of waiting on the
existing refund id. A PENDING Square refund is documented as a normal accepted
`RefundPayment` response, so collapsing it into `false` loses the "accepted,
not yet settled" signal.

Update: PR #1912 (stable Stripe and Square refund idempotency keys) has since
landed on `main`; the Square refund idempotency key is now the stable
`refundIdempotencyKey("square", paymentId)` rather than a fresh
`crypto.randomUUID()`, so a redelivery re-posts with the SAME key and Square
dedupes it — the double-pay half of the risk above is now mitigated. The
PENDING-still-returns-false behaviour itself (a retryable re-attempt that waits
on `isPaymentRefunded` rather than holding the refund id) remains, so the
pending-result union below is still the real fix; the stale-key concern is
resolved.

The fix is the staged-checkout pending-result union / callback resolution this
PR was explicitly told not to introduce: surface a pending outcome (carrying
the refund id) separately from a plain false, and have the webhook/admin refund
paths hold/redeliver against that id instead of re-posting. That is the same
machinery planned for #1853 (`split/staged-checkout-runtime` — "Finish and
recover paid checkouts safely") and overlaps #1905
(`split/authoritative-payment-callbacks` — provider-neutral webhook retry
resolution), so it must be designed with those branches, not duplicated here.
Starting points: `squareApi.refundPayment` in `src/shared/square.ts` (where the
boolean contract lives), the idempotency key in its `withClient` callback, and
the downstream `tryRefund` in `src/features/api/payment-processing/refunds.ts`
plus `refundReferenceAtProvider` in
`src/features/admin/refunds/provider.ts` (both treat `false` as failed and fall
back to `isPaymentRefunded`, which a still-pending refund also fails).

---

## Validate Square orders/payments responses with Valibot schemas

*Origin: CodeRabbit review of PR #1911. The refund response validation is done
(`SquareRefundResponseSchema` in `src/shared/square.ts`), and the test file
splits are complete (`refund-payment.test.ts`, `refund-transport.test.ts`,
and the shared `mock-fetch.ts` helper all exist; `retrieve-refund.test.ts` is
240 lines and `rest-transport.test.ts` is 372). What remains is extending the
same boundary-validation pattern to the orders and payments client methods.*

The Square REST client still maps order and payment responses with type casts
(`get<T>` for orders and payments). `squareFetch` returns `JSON.parse(response.text)`
cast as `<T>`, so a malformed order or payment object — wrong field types, an
unexpected shape — passes through unvalidated. The refund path now has a Valibot
schema (`SquareRefundSchema` / `SquareRefundResponseSchema`) parsed with
`v.parse` OUTSIDE `withClient`, so a malformed refund response fails loudly.
Doing the same for orders and payments means defining `SquareOrderSchema` and
`SquarePaymentSchema` and parsing in their respective `squareApi` methods, so
a malformed response throws rather than being silently cast. Starting point:
`squareFetch` and the `SquareOrderResponse` / `SquarePaymentResponse` types in
`src/shared/square.ts`; mirror the refund schema shape that already exists.

---

## Split oversized test files moved by PR #1903

*Origin: Codex review of PR #1903 ("Load heavy modules only when needed").
That PR is a cold-start import reduction; as a side effect it relocated several
test files via `git mv` to mirror their source module paths (the mutation gate
requires mirror-located direct tests). Two of the moved files are over the
~400-line target in AGENTS.md:*

- **`test/features/admin/auth.test.ts` (651 lines).** Was
  `test/lib/server-auth.test.ts` (658 lines on `main`) — the move did not grow
  it. Covers login, logout, sessions, roles, invalid credentials, CSRF, and
  `wrappedDataKey` edge cases. A future PR should split it into focused files
  by concern (e.g. `login.test.ts`, `logout.test.ts`, `sessions.test.ts`,
  `roles.test.ts`) under `test/features/admin/auth/`, mirroring the
  `test/features/admin/users/` folder pattern already in place. Run
  `deno task test:files test/features/admin/auth/*.ts` after the split to
  confirm coverage stays at 100%.

- **`test/ui/templates/checkin.test.ts` (533 lines).** Was
  `test/lib/server-checkin.test.ts` (499 lines on `main`) — the move grew it
  slightly via the row-scoped assertion rewrite in `64475d4f`. Covers GET/POST
  `/checkin/:tokens` rendering, column visibility, check-in/out flows,
  refunded-attendee blocking, shared-token behaviour, and route matching. A
  future PR should split it by concern (e.g. `checkin/rendering.test.ts`,
  `checkin/flows.test.ts`, `checkin/routes.test.ts`) under
  `test/ui/templates/checkin/`. Keep the `rowFor` helper in a shared helper
  file (or move it to `#test-utils` if a second caller appears) rather than
  duplicating it across the split files.

Both files are well under the Biome hard 1,000-line ceiling
(`noExcessiveLinesPerFile`), so neither is in the `biome.json` override list.
Splitting them now was deliberately deferred because doing it inside the
cold-start PR would balloon the diff with unrelated mechanical test moves and
re-conflict with the import-only changes that are the actual subject of the
PR. The ~400-line target is guidance, and the cold-start PR's brief was
explicitly about import-graph narrowing, not test reorganisation.

## Mutation coverage of `src/features/api/folded-booking.ts` (direct tests)

Direct tests at `test/features/api/folded-booking.test.ts` and
`test/features/api/folded-booking/parent-booking.test.ts` kill every non-equivalent mutant on the unchanged `folded-booking.ts`.
Five equivalents (lines 87, 118, 176, 301, 381) are recorded in
`scripts/mutation/equivalent-mutants.txt` with proofs — no unsuppressed survivors remain.

## Split `render-selector.test.ts` by what each case actually checks

*Origin: Codex review on PR #1926 (test reorganisation).*

`test/integration/server/parents-gate/render-selector.test.ts` holds four cases
with three different subjects: one changes a setting and checks the effect, one
checks how the parent booking page renders its fields, and two only exercise the
test helper `selectOptionsFromHtml` (they assert it throws when the select is
missing, and that it ignores a non-select element of the same name). Whichever
source is mutation-tested, three quarters of the file is unrelated work.

Out of scope for #1926, which was file moves only — separating these needs edits
inside the tests. Starting point: move the two helper cases next to the helper
they test — it now lives at `test/test-utils/parents-gate/helpers.ts`, so they
belong in `test/test-utils/parents-gate/helpers.test.ts` — keep the rendering
case in the integration tree, and let the settings case sit with the other
settings behaviour.

## Let the misplaced-test list see past request helpers

*Origin: Codex reviews on PRs #1926 and #1929 (test reorganisation).*

The misplaced-test list only considers a test that resolves to exactly one
source. Start-up helpers (`describeWithEnv`, the env overlay) used to drag the
database, config and storage in as extra subjects, which pushed real findings
over that limit and hid them; those two helpers are now skipped.

The blanket version of that skip — ignoring all of `test/test-utils/` — is not
safe, and the numbers show why. It raises the list from 1 entry to 8, but at
least two of the new entries are wrong in a way that would damage the suite if
followed: `test/features/app/request/organic-maintenance.test.ts` and
`test/features/admin/built-sites/server.test.ts` drive real pages through
`session.ts` and import a database module only to check the result. Skipping
`session.ts` throws away the route they are actually about and leaves the
incidental database import as the sole subject, so the list recommends moving a
correctly placed HTTP suite into a database mirror.

The fix is in the report rather than the walk: a test that loads the app should
count as an integration test however it reaches it. Today `findMisplacedTests`
only checks for a direct `#routes` import, so reaching the app through a helper
is invisible to it. Make that check consider the whole walk (including helpers,
and route modules under `#routes/…`, not just the entry itself), and the blanket
skip becomes safe — worth roughly seven extra genuine findings.

Starting points: `findMisplacedTests` in `scripts/unit-tests-report-imports.ts`
(the `test.imports.includes(appEntry)` guard and the `subjects.length !== 1`
guard), and `SHARED_SETUP_FILES` in `scripts/test-subjects.ts`.

## Split the compact test reporter (from PR #1944 review)

Codex flagged `scripts/compact-test-reporter.ts` at 561 lines, above the ~400
target. It holds five separate jobs: reading the `deno test` arguments and
guessing how many tests will run, parsing TAP failure reports, drawing the
progress bar, printing the run summary, and running the child process.

The tests for it already sit in `test/scripts/compact-test-reporter/` as
`estimate`, `diagnostics`, `progress`, `reporter` and `summary`, so the source
can be split into a folder of the same names and each pair stays mirrored (which
is what the mutation gate wants). Out of scope for #1944, whose job was closing
the mutation gaps rather than moving the file around; the file scores 100% as it
stands, so the split can be a pure move.

---

## Mutation gaps in `src/shared/crypto/encryption.ts`

*Origin: mutation run while speeding up owner-key encryption (PR #1945).*

`deno task mutation --source src/shared/crypto/encryption.ts --test
test/shared/crypto/encryption.test.ts` reports **41 survivors out of 90**, a
score of 54%. None came from that change; they are gaps the run happened to
surface. They fall into three groups.

**The binary file format** (`encryptBytes` / `decryptBytes`, the `ENCB` header —
roughly lines 254 to 301). Most of the survivors are here: the magic bytes, the
version byte, the header offsets, and both format errors can all be mutated
without a direct test noticing. These functions are only reached today through
integration tests (`test/features/images.test.ts`,
`test/integration/attachment-route.test.ts`,
`test/ui/templates/admin/settings/header-image.test.ts`), which the direct-test
run does not include. They want unit tests in `test/shared/crypto/` covering the
header layout byte by byte, a wrong magic, and a wrong version.

**Key caching and change notification** (lines 65 to 136): clearing the two
resolved-key caches and running the registered change callbacks can be removed
without a test failing. A test that changes the key and then checks the *next*
encryption uses the new one would close this.

**The key import flag** (line 119): `false` → `true` on the `extractable`
argument of `crypto.subtle.importKey`. No behaviour can tell these apart,
because the key is never exported — a genuine equivalent mutant. Either record
it in `scripts/mutation/equivalent-mutants.txt` with that reasoning, or find an
assertion on the imported key itself. `importRsaKey` in
`src/shared/crypto/keys.ts` has the same shape.

Start with the binary format: it is the bulk of the count and the group where a
surviving mutant would represent a real risk to stored files.

---


## Let Deno-hosted sites with a Bunny database be migrated

`POST /instance/site-credentials` (`src/features/instance.ts`) only returns
sites whose `hostingProvider` is `"bunny"`, but the builder also supports
`hostingProvider: "deno"` with `dbProvider: "bunny"`. Those sites hold a Bunny
database and cannot be moved with `deno task migrate:sites`, because the menu
never sees them.

A reviewer on PR #1940 suggested returning the hosting provider and id from the
endpoint and dispatching the secret update through `resolveHostingProvider`
(`src/shared/site-assignment.ts`), which is the right shape. It was left out of
that PR because relaxing the filter changes what the deploy workflow receives:
`.github/workflows/deploy-clients.yml` posts new code to
`api.bunny.net/compute/script/<script_id>` for every site the endpoint returns,
so a Deno-hosted site appearing in that list would break the deploy. Doing this
properly means the workflow (and `.github/actions/backup-site/action.yml`) must
learn to skip or handle non-Bunny hosting first.

Starting points: the `hostingProvider === "bunny"` filter in
`src/features/instance.ts`, `setSiteSecrets` in
`src/shared/site-assignment.ts`, and the per-site loop in
`.github/workflows/deploy-clients.yml`.

---

## Split the hybrid encryption section out of `src/shared/crypto/keys.ts`

*Origin: reviewer suggestion on PR #1945.*

`keys.ts` is 499 lines and holds three separate jobs: KEK derivation, symmetric
key wrapping, and hybrid RSA+AES encryption. The hybrid section is the natural
one to lift out — `hybridEncrypt`, `hybridDecrypt`, their TTL decrypt cache,
`encryptWithOwnerKey` / `decryptWithOwnerKey`, and the RSA key import pair. That
would leave `keys.ts` about 370 lines and focused on keys, and would sit
naturally beside `src/shared/crypto/aes-gcm.ts`.

It was left out of #1945 because that PR did not cause the overage: `keys.ts`
was already 494 lines before it and grew by five. (The same rule did apply to
`encryption.ts` there, which the change pushed from 391 to 443, and that one was
split.)

The move itself is mechanical, but it is wide: `encryptWithOwnerKey` and
`decryptWithOwnerKey` are used across attendee PII, the activity log, email
preferences, and bulk email drafts, so every importer needs repointing.
Remember `src/docs/crypto.ts`, which re-exports whole crypto modules for the
generated API docs — a moved export silently disappears from them otherwise.

Starting point: the "Hybrid Encryption" section of `src/shared/crypto/keys.ts`,
and `grep -rn "encryptWithOwnerKey\|decryptWithOwnerKey\|hybridEncrypt" src/`.

---

## Make `--clean` synchronize with the run lock before removing a run

*Origin: reviewer suggestion on PR #1951.*

`cleanableRuns` in `scripts/mutation/isolation.ts` decides a `copying` run is
abandoned when its lock is not held, and `removeRun` then deletes
`record.root` recursively. Neither step takes the run lock, so a run can pass
the check while still queueing, take the lock, and start copying — and the
clean, already committed to its decision, removes the record and the
half-copied snapshot underneath it.

PR #1951 narrowed this: the run now writes its record again once it holds the
lock, so a clean that lands entirely *before* the lock leaves a run that is
still findable. That is the common ordering and it is covered by
`recordAroundClean` in `test/scripts/mutation/isolation/helpers.ts`. The
remaining window — clean decides, run takes the lock, clean removes — is not
closed by that write, and no write can close it: the fix has to be that the
clean holds the run lock across both the decision and the removal.

It was left out of #1951 because that PR is about test coverage of
`isolation.ts`, and this is a behaviour change to the clean path with its own
concurrency design to think through (a clean that blocks on every run's lock
must not hang on a genuinely live run — the existing `runLockIsHeld` check
would become a `tryLock`).

Starting point: `cleanableRuns`, `removeRun`, and `cleanRuns` in
`scripts/mutation/isolation.ts`, plus `withMutationRunLock` and `runLockIsHeld`
in `scripts/mutation/isolation-state.ts`.

---

## Decide what happens to undated bookings when a listing starts being booked by the day

*Origin: found while migrating the multi-day tests to stories (PR for batch 8).*

A listing booked as one date can be switched to being booked by the day. The
people who booked before the switch have no day of their own (`start_at` is
NULL), and the per-day capacity count deliberately excludes them on a daily
listing — see the null-start_at case in
`test/e2e/duration-days/booking-flows.test.ts`.

The effect is that a full listing stops being full the moment it is switched. A
Hall with room for 2, with both places taken, accepts a further booking on any
day after the switch, so it ends up holding 3 people. The listing's *total*
check still counts them (`attendeesApi.hasAvailableSpots(id, 1)` with no date
returns false), so the two checks disagree.

This may be intended — an undated booking genuinely has no day to block — but
nothing states the intent, and an organiser switching a sold-out listing would
not expect it to reopen. Worth an explicit decision: either give the undated
bookings a day at the point of the switch, count them against every day, or
refuse the switch while undated bookings exist.

It was out of scope for the migration, which only moves existing tests into
stories. A story asserting "people booked before the change still take up room"
was written and then removed, because the product does not do that today.

Starting point: `attendeesApi.hasAvailableSpots` and the per-day capacity SQL in
`src/shared/db/attendees/capacity.ts`, plus the listing-type switch in
`src/features/admin/listings-edit.ts`.

---

## Tell the story of a refused "stop selling this on its own"

*Origin: reviewer suggestion (Codex) on PR #1952.*

The site refuses to stop selling an add-on on its own when doing so would leave
another add-on with no way to be bought — `strippedPageOrphanedAddOn` in
`src/shared/listings-actions.ts` re-runs the reachability guard and blocks the
save. The story `bookings.add-ons-sold-on-their-own` covers only the plain
cases, where nothing depends on the page, and its rule is worded to say so.

The refusal is an operator-facing rule worth telling: the organiser is stopped,
and told which add-on would be stranded. It was left out of that PR because
setting it up needs a child-scoped optional modifier, which no story support
builds yet — a bigger piece of scaffolding than the migration it sat in.

Starting point: `strippedPageOrphanedAddOn` and
`firstChildUnreachableAddOnForListings` in `src/shared/db/modifier-resolve.ts`,
plus whichever direct test already covers the guard, for the shape of the
fixture.

---

## Test the door's confirmation steps in the browser script

*Origin: reviewer suggestion (Codex) on PR #1959.*

`src/ui/client/scanner.js` is the only part of checking people in that nothing
tests. It is the script that shows the organiser the question the door asked —
"this ticket is for another listing, let them in anyway?" and "check this
person's ID first" — and sends the second request carrying their answer.

The story `attendees.checking-people-in-at-the-door` reads a ticket, gets the
query back, and then sends the answer, which is the same pair of requests the
script makes. What it cannot do is press the button: `TestBrowser` runs no
JavaScript, so a broken confirmation prompt would leave the story green.

That is a pre-existing gap — `scanner.js` had no test before this story either,
and it is the only client script in `src/ui/client/` with none. Closing it needs
a DOM test in the shape of `test/ui/client/order.test.ts`, which was too much
scaffolding to add inside a test migration.

Starting point: `src/ui/client/scanner.js`, the confirmation branches around its
handling of `wrong_listing` and `verify_id`, and `test/ui/client/order.test.ts`
for how a client script is driven without a real browser.


## Watch for ports being taken between tests

*Origin: the chunk that took `scripts/stripe-mock/install.ts` to a full
mutation score (#1966), and the flaky runs it uncovered.*

The tests under `test/scripts/stripe-mock/install/` failed about one run in
three: five failed runs out of roughly fifteen, a different test each time, and
each one passing when run on its own.

The cause was a port being taken between choosing it and using it.
`withUnusedPort` opens a port to find a free one, closes it, and hands the
number over. Another test starting at that moment can take the same number. The
starter then sees something already listening and reports success, so a test
that asked for a failure was handed somebody else's mock instead.

`expectStartFails` now treats that as "ask again on a fresh port" rather than a
pass, and gives up loudly if it keeps happening.

What is left is a wider version of the same problem: any test that picks a port
and then lets go of it before use can be gazumped. The install tests are the
ones that noticed, because they are the ones that assert a failure. Worth
looking at whether ports should be handed out so that no two tests in a run can
ever receive the same one.

## Payment-record findings that need the code using the record

*Origin: Codex review on PR #1973, which landed the payment record's tables and
the words for what a payment is — but nothing that reads or writes them.*

Four findings from that review describe real gaps, but each one's fix is a
choice about what the payment should *do* instead, and nothing in that change
made the choice: the repositories, the runtime, and the copy that brings older
payments across all arrive later. They are recorded here so the slice that
lands each consumer settles them, rather than inheriting them silently.

Three findings from the same review were fixed in that change, because they
were wrong whatever uses them: a payment could be saved with no id, a current
charge could be saved with no refunded total and no provider, and an old charge
could be saved without saying where it came from. All three were rules that
compared against a missing value, which SQLite lets through.

**The same money can be attached to two payments.** A charge is unique per
payment and reference (`idx_payment_charges_payment_reference` in
`src/shared/db/migrations/schema/payments/charges.ts`), so the same provider
charge on two different payment records is allowed. Either could then complete
a booking or ask for a refund against money the other already spoke for.

Making the reference unique on its own is not a straight swap: that composite
pair is also the upsert key (`ON CONFLICT(payment_id, reference_index)` in
`charge-upsert.ts` on the aggregate branch), so the extra rule has to be an
additional one. It also collides with a known upgrade fault already recorded
above — a SumUp payment known by two ids can produce two records for the same
money — where a unique rule would turn a split record into a failed upgrade.
Decide it with the copy code in hand, and say which of the two failures is
preferred.

**A refund the provider says is done can leave the money refundable.**
`resolveRefund` (`src/shared/payment-state/refund.ts`, around line 52) reads a
completed refund, then answers from the charge's confirmed refunded total
instead. While that total still says zero — a normal delay between the two
readings — the answer is "no refund seen", which reads as refundable, so
another refund can be sent for money that has already gone back. The two
readings disagreeing is not "nothing happened": it should be held as still
going, or put in front of the owner. Which of those is right depends on what
the refund runtime does with each answer.

**A failed checkout that took money is thrown away.** `foundReadResolution`
(`src/shared/payment-state/resolve.ts`, around line 229) answers "ignore" for
any failed observation, including one carrying a charge with money on it. A
buyer whose checkout failed after the money was taken then has no booking, no
refund, and nothing raised for the owner. A failed payment holding a captured
charge should be a conflict instead. Note the related finding above about a
failed payment already answering "conflict" from the terminal map — settle both
together so the buyer's cancel page and the owner's list agree.

**An owner's decision can carry the wrong evidence.** In
`src/shared/payment-state/lifecycle.ts` (around line 205) the choice made and
the review it was made from are checked separately, so a decision can pair a
choice about an old payment with a review of a current payment's charges, or
the reverse. The worker acting on it then has evidence describing a different
payment, on a path that moves money and cannot be undone. The fix is to model
the allowed pairs as variants so an impossible pairing cannot be built at all.
Doing that needs the decision writer and worker in view, so the variants match
what is actually offered.

**A current payment's result can disagree with where it is.** On
`payment_sessions` (`src/shared/db/migrations/schema/payments/sessions.ts`) the
old-payment half of the rule ties each result to the state it can exist in —
a succeeded result only on a completed payment, a failed result only on a
failed one. The current-payment half only ties whether there *is* a result to
whether the result state is "none". So a payment still being created can be
stored as having succeeded, and a completed one as having failed. Someone
reading where the payment is and someone reading how it turned out then get
opposite answers about whether the booking ran.

The fix is to name the allowed pairs the way the old-payment half already
does. Which pairs those are is the runtime's own state machine — whether a
result may be written while a payment is still processing, what a refunding
payment's result says — so it should be written with that code in view rather
than guessed. Guessing too narrowly refuses writes the runtime makes on the
happy path.

**A payment still going is believed without checking it.** `foundReadResolution`
(`src/shared/payment-state/resolve.ts`, around line 226) answers "still going"
for any pending reading, before `validatePaymentObservation` has run. So a
reading whose money does not add up — a total that disagrees with what was
asked for, a charge belonging to another checkout, a refund larger than the
money taken — is asked about again in a minute rather than put in front of the
owner, for as long as the provider keeps saying "pending".

Checking it first is the obvious answer, but it is not safe to do blind: the
check refuses any reading whose provider total differs from the expected
amount, and what each provider reports as the total while a checkout is still
open is the provider readers' business. If any of them reports zero until the
money is taken, adding the check turns every ordinary pending payment into a
case. Settle it with the provider readers in view, and pick which parts of the
check apply before the money has arrived.
