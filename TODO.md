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

## Codex Security scan follow-ups

*Origin: Codex Security scan completed on 2026-07-29 at
`/home/user/.codex/state/plugins/codex-security/scans/tickets/codex-security-tickets-qkJ7hC/`.*

Findings 2 and 4 are active worktree jobs:

- `work/security-finding-2-setup-race` for concurrent first-run setup.
- `work/security-finding-4-bunny-deploy-action` for the mutable Bunny deploy
  action reference.

Finding 1 (delivery-agent access to check-in attendee details) shipped on PR
#1995.

These are the remaining scan items that still look worth doing under the
current trust model. They assume Bunny Edge remains the production runtime,
site owners are trusted with their own content and integrations, and deployment
operators own the risk of choosing deliberately hostile third-party endpoints.

- **Make rate-limit writes atomic and bounded.** `src/shared/db/login-attempts.ts`
  and `src/shared/db/token-attempts.ts` update shared rows with read-then-write
  sequences, so concurrent attempts can lose increments, and below-threshold
  rows are not pruned. Fold the login, API-key, booking, address-lookup, and
  token limiters onto one atomic update/prune shape, with regression tests that
  drive concurrent attempts. (The expired-lockout cleanup race in
  `src/shared/db/attempt-lockout.ts` is fixed: the delete is conditional on the
  observed `locked_until`, so a fresh lockout survives cleanup —
  `test/shared/db/attempt-lockout.test.ts` proves it.)
- **Preserve the client IP in production request scopes.** `src/edge.ts`,
  `src/deploy.ts`, and `src/serve-app.ts` should carry the platform connection
  context into the shared request handler so production rate limits do not fall
  back to one global bucket. Add direct entrypoint tests that prove two client
  IPs do not share a limiter row.
- **Stop cross-origin redirects from replaying secrets or PII.** The shared
  fetch path in `src/shared/safe-fetch.ts` is used by registration webhooks and
  SMS delivery. Do not let a cross-origin redirect replay attendee data,
  ticket capability links, or Basic credentials. Prefer failing closed on
  cross-origin redirects unless a caller has a very narrow, tested reason to
  follow one.
- **Make attachment caching match signed URL access.** `src/features/attachments.ts`
  and the middleware currently let public caches keep a time-limited attachment
  response longer than the URL authorization window. Set cache headers from the
  signed URL expiry, or make private attachment responses non-publicly
  cacheable, and test the exact header on a signed attachment download.
- **Escape spreadsheet formulas in attendee CSV exports.** CSV fields that
  start with spreadsheet formula characters need a safe prefix before export.
  Keep the escaping in the shared CSV writer if it applies to every human-opened
  export, or in `src/features/admin/attendees-csv.ts` if attendee exports are
  the only affected surface. Add a regression test with attacker-controlled
  attendee names, emails, and answers.
- **Escape booking data in HTML notification emails.** Public booking contact
  fields flow into owner notification email HTML. Keep intentional template
  markup working, but escape user-supplied field values before they reach
  `src/shared/email-renderer.ts` or `src/shared/liquid-engine.ts`. Test a
  booking field containing HTML and a script-like value.
- **Pin or verify CI tools downloaded with credentials present.** Outside the
  deploy-action worktree, the scan flagged `cloudflared` in
  `.github/workflows/payment-sandbox-e2e.yml`, the opencode release archive in
  `.github/workflows/opencode.yml`, and the Sentry CLI range in
  `.github/actions/sentry-sourcemaps/action.yml`. Pin exact versions and verify
  checksums or signatures before those binaries run with secrets.
- **Require encrypted transport for remote Uptime Kuma.** Keep `http://` only
  for an explicitly local Uptime Kuma URL. Remote hosts should require HTTPS so
  the WebSocket login does not send monitoring credentials over cleartext.
- **Randomize public payment-test admin credentials.** The public payment e2e
  tunnel is test-only, but it uses repository-known admin credentials while the
  app is reachable through a quick tunnel. Generate per-run credentials and keep
  them out of ordinary logs before broadening that harness further.

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
- **Slice 5 — generalize `system_notes`: done.** A note now names the kind of
  record it is about and which one (`entity_type`, `entity_id`), and the notes
  module works in those terms (`src/shared/db/notes/`). What remains is per-page
  work: add `"listing"` (or whichever record is next) to `NOTE_ENTITIES` in
  `notes/target.ts`, give that record's delete path the notes delete statement,
  and add the notes section to its entity page. The list drives the database
  `CHECK`, so adding a kind ships with a small rebuild migration — as
  `2026-06-20_free_text_questions` did for `questions.display_type`.

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

- **Incompatible listings are offered by the add-listings picker.** The
  group-homogeneity messages now live in the catalog and say why (`error.group_*`
  in `src/locales/en/groups.json`), but the operator still only learns of a clash
  when the save is refused. Better: grey out the listings that cannot join this
  group in the add-listings picker, so the clash is visible before saving. The
  rule to render from is `groupListingTypeError` (`src/shared/db/groups.ts`) —
  same type, and same customisable-days setting, as the members already there.

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

## Deferred Codex suggestions from PR #1975 (API documentation examples)

*Origin: Codex review of PR #1975, which made the API documentation examples
checkable and fixed eighteen real inaccuracies in them. Both items below are
valid and were deliberately left out: they guard mistakes nobody has made yet,
and each costs more machinery than the defect it would catch.*

- **Validate admin request fields against their production constraints.**
  `test/shared/admin-api-example/helpers.ts`'s `isBlank` judges a documented
  request value by its sign and whether it is zero. A positive *fractional*
  value (Codex's example: `duration_days: 1.5` in the listing create body)
  therefore passes, while `API_BODY_FIELD_RULES` requires a safe integer and
  the real endpoint answers 400. Fixing it properly means running each request
  example through the endpoint's own field rules rather than a hand-written
  check. Starting point: `API_BODY_FIELD_RULES` in `src/features/admin/api.ts`.

- **Derive the documented create slug from what a create really does.**
  `crudDocs` in `src/shared/admin-api-example.ts` builds the create response
  from the example record, so it keeps `summer-workshop`; the listing and group
  POST converters call `generateUniqueSlug`, which emits a random five-character
  slug. The documented create response therefore cannot result from its own
  request. Left alone because the honest fix — showing `a7f3k` — makes the page
  harder for a person to read, which is a documentation judgement rather than a
  correctness one. Starting point: `generateUniqueSlug` in `src/shared/slug.ts`.

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

- **Bulk-group-duplicate form loses inputs on a failed POST**
  (`src/ui/templates/admin/bulk-actions.tsx` `adminDuplicateGroupPage`). On a
  validation error the form re-renders with defaults (`${group.name} (copy)`,
  blank find/replace/date) instead of the submitted values. Pre-existing: the
  page's `values` param was already unused before this branch (this dedup only
  deleted the dead param), so the form has never re-filled on error. Fix: thread
  the submitted values back into the `TextField`/`TextFields` inputs, following
  the flash/form-refill pattern other admin forms use.

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

## Bunny subrequest budget follow-ups

*Origin: request-fan-out audit for PR #1820.*

Bunny stops an edge request after 50 subrequests. PR #1820 adds a request-scoped
database guard that blocks libsql call 51 and fixes the concrete failures found
in fresh setup, group duplication, ordinary backups, reset/restore, and bulk
refunds. The paths below still have data-dependent fan-out. The guard makes the
database-only cases fail loudly, but it cannot count provider or storage calls.

- ~~**Package carts and payment completion.**~~ Done. `resolveCartSlugs` now
  resolves every package slug through `loadCartPackagesBySlugs`
  (`src/features/public/groups.ts`) in four reads however long the cart is, and
  `loadPackagePricingByGroup` loads every booked package through
  `loadPackageMemberPricingByGroupIds` in three. `validateAllItems`
  (`src/features/api/payment-processing/items.ts`) reads every order line's
  listing in one batch instead of one call per line.
  `getPackageDisplaysByIds` was already a single query.
- **Registration logs and outgoing webhooks.** `logAndNotifyRegistration` and
  `sendRegistrationWebhooks` in `src/shared/webhook.ts` can insert one activity
  row per booking, load two overrides per package, and fetch every distinct
  webhook URL. Add one bulk log insert and one batched override read
  (`loadPackageOverrides` can call `loadPackageMemberPricingByGroupIds`, which
  now exists). Persist outbound webhook jobs for bounded out-of-band delivery.
  Budget for the test work: `src/shared/webhook.ts` has about twenty surviving
  mutants today, and the mutation gate demands they all die once the file is
  touched.
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
- ~~**Remaining group admin reads.**~~ Done. `validateListingTypesForGroup`
  (`src/features/admin/groups.ts`) reads the group's members once and judges
  every candidate against that list with `groupListingTypeError`, and
  `loadGroupContext` (`src/features/admin/listings-view.ts`) resolves the
  listing's groups from the shared cache and asks for every capped group's
  remaining spots in one call.

A finished item keeps a database-call budget test, so the next per-item loop
trips the subrequest counter in a test rather than in an audit: wrap the call in
`countDatabaseCalls` (`test/test-utils/subrequest-budget.ts`) and assert the
count does not grow with the input.

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

## Mutation coverage of `src/features/api/folded-booking.ts` (direct tests)

Direct tests at `test/features/api/folded-booking.test.ts` and
`test/features/api/folded-booking/parent-booking.test.ts` kill every non-equivalent mutant on the unchanged `folded-booking.ts`.
Five equivalents (lines 87, 118, 176, 301, 381) are recorded in
`scripts/mutation/equivalent-mutants/` with proofs — no unsuppressed survivors remain.

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

## Two suites now cover the attendees list

*Origin: Codex review of PR #1993 (direct tests for the four testless modules).*

`test/features/admin/attendees-list.test.ts` was added because the mutation
gate needs a test at the source's mirrored path. It calls the handlers
directly. But `test/integration/server/attendees-list.test.ts` already drives
the same behaviour over HTTP — authentication, the listing filter, sort order
and paging — and `test/integration/server/attendees-csv.test.ts` covers the
export. So the same rules are now checked twice.

That costs runtime on every suite run, and lets the two sets of fixtures and
expectations drift apart. The fix is to consolidate: move the route-level cases
into the mirrored feature suite (which can call the handler directly *and* go
through the router where that is the point), and delete what is left behind.

Not done in #1993 because that change touches suites the PR otherwise had no
reason to open, and the mirrored suite had to exist first. Worth doing next
time either file is opened.

Starting point: the three files named above.

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

---

## Prove a bundle's blank price really charges the thing's own price

*Origin: reviewer suggestion (Codex) on PR #1968.*

The story `bookings.selling-things-as-one-bundle` proves the *saving* half of
the blank-price rule: leaving a part's price empty on the bundle form stores no
price of its own for that part. It does not prove the *charging* half — that the
customer is then asked for that thing's own price rather than nothing.

Its rule is worded to say only what it proves. Closing the gap needs a paid
bundle taken all the way through a payment provider, which is what the money
stories already set up (`test/specs/support/money-drivers.ts`), so the natural
home is a scenario there rather than another one here. A bundle mixing an
overridden part with a blank one, bought and paid for, should be charged the
override plus the blank part's own price.

Starting point: `packageMemberMaps` in `src/shared/db/groups.ts` for what counts
as an override, and `test/integration/server/cart-packages.test.ts` for how a
priced bundle reaches checkout today.

---

## Give the stripe-mock install lock the same shape as every other file lock

*Origin: noticed while unifying the locks behind `scripts/lock-file.ts`.*

Every lock that is a file — the precommit gate, the browser-asset build, the
stripe-mock start, each mutation run — now goes through `withFileLock`, which
holds one advisory lock and checks that the lock it holds is still the file at
its path. (The database migration lock is not one of these: it is a row in a
table, and is named below for the pattern it shares.)

`scripts/stripe-mock/install.ts` is the exception: it has a second,
hand-rolled protocol underneath (`createNew` to claim the lock, a timestamp
written inside it, and `removeStaleInstallLock` to break a lock whose owner
died), guarded by a `withFileLock` on a separate guard file.

It answers a question the shared lock cannot: "whoever claimed this walked away,
so take it from them". Two other places answer that same question their own way:
the mutation runner uses a record with a status, a pid, and a startup grace plus
`processExists`, and the database migration lock
(`src/shared/db/migrations/lock.ts`) writes an owner into a settings row and
lets anyone break a claim older than `MIGRATION_LOCK_TTL_MS`. Three mechanisms
for one job.

Worth folding into one: either teach `lock-file.ts` about an owner that can go
away, or let the install reuse the run-record shape. It stayed out of PR #1957
because it is a whole protocol, not a shared helper, and the install path has
its own timing tests.

Starting point: `tryAcquireInstallLock`/`removeStaleInstallLock` in
`scripts/stripe-mock/install.ts`; `acquireMigrationLock` in
`src/shared/db/migrations/lock.ts` is the best-worked-out version of the pattern
and the one to copy; `activeByRecord` in `scripts/mutation/isolation-cleanup.ts`
is the third; and `test/scripts/stripe-mock/install/stale-locks.test.ts` and
`waiting.test.ts` say what the timing tests expect.

## Tell a clear-up's hold on a run apart from the run's own

*Origin: reviewer suggestion (Codex) on PR #1957.*

`processBelongsToRun` in `scripts/mutation/isolation-cleanup.ts` decides a run
belongs to the process in its record when that process is alive *and* somebody
is holding the run's lock. A clear-up deleting that run's folder holds the same
lock, so during a deletion the two are indistinguishable.

That matters in one case: the record's process id has since been given to some
unrelated program. `--kill` then reads "alive and locked" as proof and signals a
process that has nothing to do with us. Deleting a whole checkout copy takes
long enough for the window to be real.

It needs the lock evidence tied to the run's own child rather than to whoever
holds the lock — the holder could write who it is, or a clear-up could hold
something a run never holds. Either is a change to what a lock means here, which
is why it did not ride along with PR #1957.

Starting point: `processBelongsToRun` and `removeRun` in
`scripts/mutation/isolation-cleanup.ts`, `signalRun` in
`scripts/mutation/isolation.ts` for what acts on the answer, and
`scripts/held-lock-process.ts` for the process that holds a lock on our behalf.

---

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

It has since been seen more, in `test/scripts/stripe-mock/lifecycle.test.ts`
("stops trying once the mock has been started as many times as asked", on CI for
PR #1968, and "gives a mock time to shut itself down before killing it", on CI
for PR #2032 — the latter now hardened: the fixture notes when it wins its
port, and the test retries on a fresh port when that note is missing), with a
second symptom worth knowing about. That test counts how many
times the fake mock was started and expects one start per try asked for. A try
whose freshly picked port already has something listening on it is abandoned
*before* the mock is started, so the count comes up short and the test fails —
even though the starter did try the number of times it was asked to. Handing out
ports so no two tests can receive the same one would fix this too; short of that,
the count is the wrong thing to measure.

## The Turso upload suite sometimes dies with no diagnostic at all

*Origin: CI on PR #2039, a branch that touches nothing this suite uses. It
then reproduced locally under a full `deno task test:coverage` run, while
passing many consecutive standalone runs — it needs a loaded machine.*

`test/scripts/turso-migration-file.test.ts` fails as `fail Turso migration
file — at unknown location — No TAP diagnostic was emitted for this
failure.` The first five cases pass and the rest never report, so the whole
describe dies between cases rather than an assertion failing.

The suspect is the watch in `sendDatabaseFile`
(`scripts/turso-migration-file.ts`). When a server answers before the whole
body is sent, Deno's node:http polyfill rejects an internal task nobody
awaits (`Failed to fetch: request body stream errored`), and
`watchPolyfillBodyStreamDefect` swallows that duplicate while the upload is
in flight. The watch stands down one `setTimeout(0)` after the upload
settles — its own comment admits this is a guess about when the duplicate
surfaces. On a loaded machine the internal rejection can land *after* that
one timer turn, and an unhandled rejection between cases is exactly "no
diagnostic, unknown location". A fix wants a deterministic stand-down —
e.g. hold the watch until the request's own `close` says its internals are
done — proven by a test that forces the late rejection, not by timing luck.

---

## The gap between a mutation child ending and its supervisor taking the lock

*Raised by Codex on [PR #1976](https://github.com/chobbledotcom/tickets/pull/1976),
about `scripts/mutation/isolation.ts` and `scripts/mutation/isolation-cleanup.ts`.*

A run's copy is protected by its lock, held by the child while it works and by
the supervisor afterwards. Between the child ending and the supervisor taking
the lock, nobody holds it. A mutation command starting in that moment sees a
record that says "running" with a process that has gone, and — once the run is
older than the startup grace — may delete the run's folder.

Today that costs a run its copy-back: the read fails, the run is reported as
failed, and the work has to be run again. It is loud, not silent, and it needs
a second mutation command to start inside a window of a few milliseconds.

The fix is to stop judging a run's liveness by the child alone. If the record
also carried the supervisor's process id, a run would count as live for as long
as the supervisor is up, closing the gap. That means changing what
`runProcessIsUp` and `activeByRecord` in `isolation-cleanup.ts` consider alive,
and thinking again about the startup grace, which exists because a process id
can be given to somebody else after the original has gone. Start at
`RUN_STARTUP_GRACE_MS` in `isolation-state.ts` and the comment above it.

## Four feature modules had no test at their mirrored path — now they do

*Origin: `deno task precommit:mutation` on the notes-migration branch, which
could not start. Closed by the direct-test pass that followed.*

All four now have a direct test at their mirrored path, so the gate no longer
refuses to start on a branch that touches them:

- `src/features/admin/attendee-page.ts` → `test/features/admin/attendee-page.test.ts` (100%, two recorded equivalents)
- `src/features/admin/attendees-list.ts` → `test/features/admin/attendees-list.test.ts` (100%)
- `src/features/admin/listing-page-data.ts` → `test/features/admin/listing-page-data/` (100%, one recorded equivalent)
- `src/features/api/payment-processing/store-refund.ts` → `test/features/api/payment-processing/store-refund.test.ts` (100%)

Every one of them now catches every mutation the gate demands, so a branch
touching any of them can pass without first writing the tests that should
already have existed.

`src/features/admin/attendee-notes.ts` was in the same state and was fixed
earlier: its route suite drives real pages through the session helpers, so it
moved from `test/integration/admin/` to `test/features/admin/`, which is where
that kind of suite belongs (see "Let the misplaced-test list see past request
helpers" above).

## Two people setting a site up at the same moment can both succeed

Raised on #1988 by both automated reviewers, and confirmed against the code.
It is a production bug, not a test gap, and it is deliberately left out of that
pull request because that branch changes no production code and this sits in
the most security-critical path we have.

**What happens.** `handleSetupPost` (`src/features/setup.ts`) asks
`isSetupComplete()` and then calls `settings.setup.complete`. Nothing holds
between the asking and the doing, so two requests that arrive together can both
be told the site is empty. `completeSetup`
(`src/shared/db/settings/setup.ts`) then runs its batch twice.

The unique index on `username_index` saves us only when both people pick the
*same* name. Two different names both insert, and the second batch's
`settingUpsert` calls overwrite `PUBLIC_KEY` and `WRAPPED_PRIVATE_KEY` with a
second keypair. The first owner is left holding a wrapped data key for a data
key the site no longer uses — they can sign in and read nothing.

**Why it is not simply "add a guard".** The batch cannot decide anything
mid-flight, so making the owner insert conditional still leaves the four
setting upserts landing unconditionally. Whatever fixes it has to make the
whole ceremony refuse to run twice — an interactive transaction that re-reads
`setup_complete` inside the write lock, or a single conditional write that
every other statement hangs off. That is a design decision in the code that
holds everybody's encryption keys, so it wants its own change and its own
review, not a corner of a test PR.

**Where to start.** `completeSetup` in `src/shared/db/settings/setup.ts` —
`withTransaction` from `src/shared/db/client.ts` is the tool, and the header
comment on the current batch explains why it is a plain batch today (all values
are computed up front). The guard in `handleSetupPost` at
`src/features/setup.ts:114` stays useful as the cheap first check.

**Proving it.** A story cannot show this today: Cucumber awaits each step, so
the two posts never overlap. #1988 covers the neighbouring case it *can* reach
honestly — a person who had the setup page open before somebody else finished,
sending their stale form afterwards. A real test for this one needs both posts
started together behind a barrier, and it should be written with the fix.

---

## An answer filed under a listing nobody booked

*Origin: review of PR #1990 (the booking-check slice), 2026-07-29.*

Free-text answers travel through checkout filed under the listing they belong
to, as `{"12": [{"q": 3, "s": 400}]}`. `ListingKeySchema` in
`src/shared/booking-intent.ts` checks that the key is written the way a listing
id is written, so a key of any other shape stops the booking rather than losing
the answers under it after the buyer has paid.

What it cannot check is whether that listing was one of the ones actually
bought. A key of `"12"` on an order for listings 3 and 7 passes the shape rule,
and `saveSessionAnswers` in `src/features/api/payment-processing/create.ts` then
looks up each booked listing in turn, finds nothing under 3 or 7, and saves no
answers. The buyer answered a question and the answer quietly goes nowhere.

The schema is the wrong place for the check: it validates one booking's metadata
on its own, and the listings that were bought are decided later, once the items
have been priced and loaded. The natural home is next to
`saveSessionAnswers`, which already has both the answer map and the booked
listings — compare the two sets and raise any key that matches no booked
listing, the same way an unreadable booking is raised.

Start at `saveSessionAnswers`, and at `test/shared/booking-intent.test.ts`,
where the shape rule is covered and the "names a booked listing" rule is not.

---

## A create whose row can't be read back should not look retryable

*Origin: Codex review on PR #2002, which added the loud failure for a create
whose just-written row can't be read back.*

`writeEntity` (`src/shared/rest/write-entity.ts`) writes the row, commits, then
reads it back on the primary. When a create's read-back finds nothing it now
raises an error. That error leaves the API write path in
`src/shared/rest/crud-api.ts` and reaches the request handler
(`src/features/app/request.ts`), which turns any unhandled error into the shared
503 page. The row itself was committed, so a client that treats the 503 as
"try again" can post the same create twice and end up with two rows.

The reviewer's suggestion was to read the row back *before* committing, so a
failed read-back rolls the insert back and there is nothing to duplicate. That
is more than a local change: each resource can supply its own
`lookupAfterWrite`, several of which join extra columns, and every one of them
would need a version that reads inside the open transaction. It also trades one
rare wrong answer for another — a row read before the commit can still be
reported to the caller when the commit afterwards fails.

`writeTableRow` in `src/shared/db/table.ts` already inserts and reads back
inside one transaction (see `test/shared/db/table/write-row.test.ts`), so it is
the place to start if the pre-commit read-back is the direction taken. The
smaller alternative is to keep the failure after the commit but answer with a
response that says plainly the create is not to be repeated, and carries the id
of the row that was made, rather than falling through to the generic 503.

Note that the id that made this reachable in the first place is now checked at
the insert (`insertedRowId` in `src/shared/db/client.ts`), so this is about the
answer given for a failure that should no longer happen — not a live fault.

## Record equivalent mutants by something that survives an edit

*Origin: two breakages on PR #2025, both caught by review rather than by any
check the branch ran.*

`scripts/mutation/equivalent-mutants/*.txt` records each known-equivalent
mutant as `path:line:column`, and `resolveEntries` in
`scripts/mutation/equivalent-audit.ts` matches all three exactly. So any edit
*above* a recorded expression silently invalidates its entry — the mutant stops
being suppressed and `deno task mutation:audit-equivalents` fails.

It happened twice on one branch. Splitting `test-browser.ts` into `parsing.ts`
and `forms.ts` moved six entries; then adding a single doc comment above
`attrValue` moved three of those same entries five lines further down. Neither
was a change to the recorded expressions themselves.

What makes it bite: `mutation:audit-equivalents` is not part of `deno task
precommit`, so a fully green precommit says nothing about whether the registry
still resolves. Both breakages were found by PR reviewers.

Two directions, either of which would help:

- **Key on something stable.** Record the expression text plus its enclosing
  function name instead of a line and column, so an entry survives anything
  that does not change the expression itself. This changes the file format and
  `resolveEntries`, so existing entries need migrating.
- **Run the audit in `precommit`** (or in CI), so drift fails on the branch
  that caused it rather than in review. It works in a copy of the checkout and
  runs no tests, so it is not obviously too slow — worth timing before
  assuming it is.

The first is the real fix; the second would catch the next one either way.
