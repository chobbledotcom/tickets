# TODO — remaining follow-ups

## Convert the remaining journey-style direct tests to Cucumber stories

_Origin: the e2e→Cucumber migration survey behind the five-story batch (support
page, owner password, removing access, booking closes, terms agreement). Those
five shipped with stories beside slimmed direct remnants. The sections below are
the next candidates the survey ranked, in order._

Each is a file whose claims read as actor-facing rules no existing `@story:`
covers. A migration is a replacement: move the journey to the Feature, keep a
slimmed direct remnant with a header naming the story for branch cover (Cucumber
runs do not count towards coverage), and record where every old claim went — the
story, the remnant, or a deliberate drop.

- `test/integration/server/tickets.test.ts` (797 lines) — the customer's
  `/t/:token` ticket page: what a booker sees after booking. Also needs
  splitting under the 400-line rule. Keep the rate-limit and token-abuse
  contracts direct.
- `test/integration/server/public/listings-display.test.ts` (424 lines) — the
  catalogue page card rules (Book now vs Buy now, hidden listings, CTA
  suppression, galleries). Keep the `x-robots-tag` and leak checks direct.
- `test/integration/server/users/invite.test.ts` — the owner-side invite journey
  (form render, duplicate refusal, join link). The invitee side is already
  `@story:access.what-an-editor-can-do`.
- `test/integration/server/settings/features.test.ts` — the feature explanation
  pages and the Site toggle that publishes the public site. Keep the concurrency
  and cache-invalidation tests direct.
- `test/integration/server/settings/email.test.ts` and `email-templates.test.ts`
  — connecting a provider and editing email templates. Keep encryption-at-rest,
  Liquid-syntax, and length contracts direct.
- `test/integration/servicing/admin-homepage.test.ts` — the organiser's
  service-event list and edit pages beside `@story:servicing.hold-and-cost`.
- `test/integration/admin/sms.test.ts` — the organiser texting an attendee
  (gateway gate, queue, log, inbound link).

---

## Keep provider reply text out of the console and Sentry (from PR #2139)

`logError` sends one `detail` string to the console, the activity log, and
Sentry. PR #2139 put the email provider's error message into the `E_EMAIL_SEND`
detail, with every email-shaped token blanked and a 300-character cap
(`failureReason` in `src/shared/email.ts`). A Codex review argued that a
provider reply can quote other personal data — a name, a phone number, a subject
line — which must not reach the console or Sentry (`src/shared/logger.ts`
promises "without PII"). No real provider message that quotes such data is
known, and registration sends never log a reason (`deliverRegistrationEmail` has
no `logError`), so the reply text stays in the detail for now.

For the stronger guarantee: add an `operatorDetail` field to `ErrorContext` that
reaches only the encrypted activity log — the same per-sink pattern as the
existing `error` field, which reaches only Sentry. `sendEmail` would then log
`provider=x status=y` as `detail` and the scrubbed reason as `operatorDetail`.
Start at `logErrorLocal`, `formatErrorMessage`, and `captureServerError` in
`src/shared/logger.ts` and `src/shared/sentry.ts`.

Review thread:
<https://github.com/chobbledotcom/tickets/pull/2139#discussion_r3855944310>

---

## Name the culprit per date in a multi-date refusal (from PR #2127)

`refusedOrderUnfitListingIds` (`src/shared/db/attendees/capacity/checks.ts`)
asks each line alone when a refused creation's lines sit on more than one date.
Two same-date lines that only fail together — a shared group limit — then name
no listing, and the operator sees the generic capacity message. That message is
the same one the site showed before the diagnosis existed, so nothing regressed.
Only an operator's hand-built creation can carry multi-date lines; the public
checkout books every dated line on one day.

To improve: group the lines by date, run the prefix binary search within each
date, and keep the write order when naming the first failed line. Codex and
CodeRabbit both proposed this on PR #2127; it was declined there as
operator-only polish outside the fix's scope.

Related ceiling, same code: `buildBatchCapacitySql` and the diagnosis probes
emit one clause per listing-day, so a same-date cart of roughly 12 daily lines
at the 90-day maximum can pass SQLite's expression-depth limit (1,000). The paid
checkout preflight (`checkBatchAvailabilityImpl`) hits it first, at checkout
time. To lift it, aggregate the per-day counting inside the SQL (one clause per
listing with a grouped per-day subquery) instead of one clause per day.

Related divergence, same code: the guarded insert evaluates its capacity and
active conditions for a zero-quantity line, but the read preflight and the
diagnosis drop zero-total buckets — a pinned contract ("treats a zero-quantity
item as a no-op that fits" in
`test/shared/db/attendees/capacity/checks/batch.test.ts`). A zero line on an
inactive or over-cap listing can therefore abort a write the preflight passed,
and the refusal then names no listing (the pre-existing first-item fallback
message). Aligning the three needs a behavior-contract decision on what a zero
line promises, so it belongs to the same follow-up as the per-date diagnosis
above.

Review thread:
<https://github.com/chobbledotcom/tickets/pull/2127#discussion_r3842274321>

---

## Give SumUp recovery anomalies a safe owner repair (from PR #2123)

`/admin/schema` reports an invalid `sumup_checkouts` row, but it offers no safe
repair action. Codex noted that an owner must use direct database access to fix
the row. This is a real product gap under the malleable-software rule in
`AGENTS.md`.

A repair cannot infer the correct money state from the invalid state word. A row
with a `sumup_id` can return to provider checks, but this path must preserve
idempotent booking and refund outcomes. A row without a `sumup_id` has no
provider resource to read. A reset to `staged` can make that row eligible for
pruning, so it can destroy the only retained evidence.

Start with a behavior contract for an owner-only detail page keyed by
`reference_index`. Show `recovery_state`, `sumup_id`, `next_check_at`, and the
safe provider evidence. Define the required owner choice for a row without a
checkout ID. The write must use the expected current values as a revision fence.
It must never mark money `unpaid`, `finished`, or `owed` without evidence.

Review thread:
<https://github.com/chobbledotcom/tickets/pull/2123#discussion_r3839410505>

---

PR #2051 shows the public site menu on booking pages (dropped in iframe mode and
when the public site is off). It builds the menu with `publicNavProps(null)`
(`renderCtx` in `src/features/public/ticket-submit.ts`), which takes
`publicNavModel`'s fixed-page fast path: two cached reads, root links only, no
active-chain highlight or contextual submenu. Codex noted that when the booking
target is a listing or group placed on an operator page, passing its
`listing:<id>` / `group:<id>` key instead would let `buildNavModel` highlight
the active chain and show the page's submenu.

Left out here on purpose: a non-null current makes `publicNavModel` run
`resolveTargets` (listing + group loads, `classifyForDiscovery`, hidden-member
and bookable-group reads) on every booking-page GET — a real cold-start /
subrequest cost on an explicitly hot path (see "Built for cold starts" in
AGENTS.md), for a highlight that only changes anything when the item happens to
sit on a nav page. The tradeoff is completeness vs the booking path's latency
budget, and the budget wins for now.

Starting point: derive the current key from `ctx.galleryTarget` (`{type, id}`,
already set for single-listing/group pages, null for multi-item combos) via
`sitePageItemTargets.of(...)`, and pass it to `publicNavProps` in `renderCtx`;
keep `null` for multi-item pages. Measure the added reads against the cold-start
benches before adopting.

---

## Let --kill stop a run through its supervisor, not the child's pid (from PR #2042)

`deno task mutation --kill` signals the child pid stored in the run record
(`signalRun` in `scripts/mutation/isolation.ts`). PR #2042 shrank the window
where that pid can be somebody else's — the record drops the pid the moment the
child's status resolves (`markChildEnded`) — but a kill that reads the record in
the few milliseconds between the child exiting and that record write can still
signal a pid the child no longer owns. CodeRabbit suggested removing the race
outright by making the stop supervisor-mediated: store the supervisor's pid in
the run record too, have `--kill` signal the supervisor, and let the supervisor
stop its own child (it holds the child handle, so no reused pid can be confused
with it). Out of scope for #2042 — it changes the record shape and the kill flow
rather than the locking this PR unified. Starting point: `signalRun` and
`markRunning` in `scripts/mutation/isolation.ts` /
`scripts/mutation/isolation-state.ts`.

---

## Numbered SQL parameters - convert repeated variable lists (from PR #2040)

`src/shared/db/numbered-statement.ts` gives a complete statement one numbered
parameter namespace. Its binder can allocate a variable list once and reuse the
tokens.

Some statements still bind the same variable-length ID list more than once.
Initial sites include `selfLinkTableSides`, `guardEdgeWriteTx`, the run-sheet
reads, and `accountsScope`. Convert them to the deferred `NumberedSql` form
before their outer writer makes the final statement.

---

## Stop printing new database tokens during Turso migration (from PR #2048)

CodeRabbit found that `scripts/turso-migration-steps.ts` prints the new
full-access `DB_TOKEN` to stdout after a successful migration. The site
migration also tells an operator to copy the printed token when automatic Bunny
secret updates fail. Removing that output without a replacement would remove the
only documented recovery path, so this needs a separate security design rather
than a payment-processing change.

Choose and document a secure hand-off for newly created Turso credentials. It
must support recovery when `scripts/site-migration/run.ts` cannot update Bunny
secrets, without putting the token in terminal logs. Then remove every token
stdout path and update the success, failure, and recovery tests. Starting
points: `scripts/turso-migration-steps.ts`, `scripts/site-migration/run.ts`,
`test/scripts/turso-migration.test.ts`, and
`test/scripts/site-migration/run.test.ts`.

---

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

## Loop-freezing mutants stall whole mutation runs (from the dates.ts fix)

PR #2097 removed the per-mutant clock, so a mutant that makes a test loop
forever now stalls the run until the run-wide deadline fails it with no score.
That is not rare: any loop whose step a one-token mutant can neutralise
(`current = addDays(current, 1)` with `1 → 0`, or `i++ → i--`) produces such a
mutant, and `src/` has roughly forty loop sites. `src/shared/dates.ts` hit it
first — two mutants on `getNextBookableDate`'s `while` step froze the tests, and
the run sat idle from minute four to the one-hour deadline. The fix there was to
restructure the file's three loops into bounded shapes (`Array.from` a day list,
then `every`/`find`), which is house FP style anyway and is the reference for
fixing the next file that hits this. The open question is whether the runner
should ever get its own answer for a test run that outlives the baseline by
orders of magnitude — a frozen loop _is_ caught breakage, CI would never go
green — but #2097 deliberately removed clocks as judges, so that is a design
decision, not a patch. Starting points: the dates.ts restructure in this PR;
`scripts/mutation/execution.ts` for the test stage the decision would live in.

The follow-up sweep bounded the freeze-capable loops across the rest of `src/`
(`range`/`entries`/`chunk`/`reduce` shapes; see the `#fp` `range` helper),
including the two files that first needed mirror direct suites built
(`src/features/admin/listings-form.ts`, `src/shared/seeds.ts`).

---

## Codex Security scan follow-ups

_Origin: Codex Security scan completed on 2026-07-29 at
`/home/user/.codex/state/plugins/codex-security/scans/tickets/codex-security-tickets-qkJ7hC/`._

Findings 2 and 4 are active worktree jobs:

- `work/security-finding-2-setup-race` for concurrent first-run setup.
- `work/security-finding-4-bunny-deploy-action` for the mutable Bunny deploy
  action reference.

Finding 1 (delivery-agent access to check-in attendee details) shipped on PR
#1995.

These are the remaining scan items that still look worth doing under the current
trust model. They assume Bunny Edge remains the production runtime, site owners
are trusted with their own content and integrations, and deployment operators
own the risk of choosing deliberately hostile third-party endpoints.

- **Preserve the client IP in production request scopes.** `src/edge.ts`,
  `src/deploy.ts`, and `src/serve-app.ts` should carry the platform connection
  context into the shared request handler so production rate limits do not fall
  back to one global bucket. Add direct entrypoint tests that prove two client
  IPs do not share a limiter row.
- **Stop cross-origin redirects from replaying secrets or PII.** The shared
  fetch path in `src/shared/safe-fetch.ts` is used by registration webhooks and
  SMS delivery. Do not let a cross-origin redirect replay attendee data, ticket
  capability links, or Basic credentials. Prefer failing closed on cross-origin
  redirects unless a caller has a very narrow, tested reason to follow one.
- **Make attachment caching match signed URL access.**
  `src/features/attachments.ts` and the middleware currently let public caches
  keep a time-limited attachment response longer than the URL authorization
  window. Set cache headers from the signed URL expiry, or make private
  attachment responses non-publicly cacheable, and test the exact header on a
  signed attachment download.
- **Escape spreadsheet formulas in attendee CSV exports.** CSV fields that start
  with spreadsheet formula characters need a safe prefix before export. Keep the
  escaping in the shared CSV writer if it applies to every human-opened export,
  or in `src/features/admin/attendees-csv.ts` if attendee exports are the only
  affected surface. Add a regression test with attacker-controlled attendee
  names, emails, and answers.
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

_Origin: visual audit of the mobile Retina screenshots generated from
`../tickets-site/scripts/screenshots/` on 2026-07-18._

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
  `the-tempest-group-checkout.png`, and `garden-party-package-checkout.png`. Add
  one shared scenario helper that blurs the active control before capture, then
  use it for all filled checkout scenarios. Keep deliberate focus only in a
  screenshot that is specifically demonstrating keyboard focus.
- **Stack the Garden Party email field on mobile.** In
  `scripts/screenshots/packages.js`, “Your Email” and its input are squeezed
  onto one row in `garden-party-package-checkout.png`, unlike the name field
  above it. Make contact-field labels and controls consistently full-width so
  the input does not crowd the label.

**Polish:**

- **Shorten the bulk-email preview.** In `scripts/screenshots/bulk-email.js`,
  `bulk-email-preview.png` is about twice as tall as it needs to be because the
  warning copy, line height, and section gaps are oversized. Reduce the scenario
  font size/line height and vertical spacing without hiding or rewriting the
  real warning. Keep the recipients, subject, warning, and full message preview
  visible.
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
  `summer-sessions-listing-form.png` is nearly 2,000 pixels tall despite already
  being limited to the Basics fieldset. Tighten field hints, editor height, and
  section spacing rather than removing the date or venue. Keep all text
  comfortably readable at the rendered `split-image` size.

**Final visual check:**

- Regenerate every scenario-owned screenshot after the fixes and inspect for
  clipped text, overflowing boxes, accidental focus rings, low contrast,
  overlapping labels, inconsistent padding, and empty space at all four crop
  edges. Also render the affected `split-image` pages at desktop and mobile
  widths so a good source PNG is not undermined by its website placement.

---

## Booking unification — phases 3 & 4

_Origin: `booking-unification.md`, `booking-unification-phase2.md`._

**Background.** Bookings used to have three independently-grown models: a normal
listing, parent/child listings (`listing_parents`), and packages (`is_package`
groups, `group_listings`). The unification collapses all three into one
**booking-node tree** (`BookingTree`/`BookingNode`) where required / optional /
fixed / hidden items are just configurations of one structure, walked by five
generalized passes: render, fold, price, capacity, revalidate.

**Already shipped (phases 1 & 2, PR #1462) — do not redo:**

- Tree model + pure builder: `src/shared/booking/tree.ts`, `build-tree.ts`
  (`buildBookingTree`). The public renderer
  `src/ui/templates/public/
  reservations/` (entry point `ticket-page.tsx`)
  drives field names/rendering off the tree.
- Unified walks: `fold-tree.ts` (`foldBookingTree`), `price-tree.ts`
  (`effectivePrice`, `priceRuleByListingId`, `packageMemberPriceRule`),
  `capacity-tree.ts` (`packageQuantityCap`, own-cap + group-pool arms).
- `foldSelectedChildren` (`src/features/public/ticket-payment.ts`) is now a thin
  adapter over `foldBookingTree`. Pricing flows through `effectivePrice` in
  `ticket-payment.ts`, `ticket-submit.ts`, `api/index.ts`,
  `payment-processing.ts`, `webhook.ts`.
- v2 signed per-node metadata: `BookingItemSchema`
  (`src/shared/.../payments.ts`, ~line 67) is `{e,q,p}` plus optional edge tags
  `k` (`"p"`/`"g"`) and `r` (group id); `signed-metadata.ts` (`signedEdgeFor`);
  webhook re-walk in `payment-processing.ts` (`validateAllItems`,
  `packageBundleMismatch`, `classifySession`).
- A package member may itself be a parent: `isPackageableMember`
  (`src/shared/.../groups.ts`, ~line 115) now permits it.
- **Row-level admin identity + per-path bookings (multi-package orders).** The
  same listing id may now legitimately book through more than one path in a
  single order (a package member beside its own standalone row; the model also
  supports two overlapping packages). One `CheckoutItem`/booking row per path,
  each tagged `packageGroupId`; the booking-slot unique index and the
  merge/check-in row keys are widened with `package_group_id`
  (`2026-07-05_package_slot_identity` migration, `bookingKey`,
  `bookingSlotKey`). `PagePackage` + `buildBookingTree` build one node per path,
  and `/order` sells packages alongside listings via the pure `#shared/order`
  evaluator (`options.ts`/`evaluate.ts`). The admin attendee editor matches: one
  editable line per stored booking row (labelled with its path), plus blank
  per-(package, member) lines behind a pure-CSS toggle, so an operator can view,
  edit, and create every path combination a public buyer could — JS-free
  (`attendee-form-model.ts`, `attendee-page-data.ts`).

**Remaining:**

- **Phase 3 — unified edge store (optional; one-way door).** Collapse
  `listing_parents` and `group_listings` into a single edge table (or make one a
  view of the other). This is the only schema-migrating, hard-to-reverse phase,
  so only take it once a concrete need demands it. Shipping phases 1–2 and
  stopping here is an explicitly _successful_ outcome, not a half-finished one.

- **Phase 4 — buyer-choice children inside a package (optional).** Let a package
  member offer a buyer-selected child (the parent/child choice UI, nested under
  a package). Build on demand when a real booking requires it.

- **`/order` live availability: fold required-child demand into options.** The
  order gallery's evaluator (`#shared/order`) judges an option by its direct
  listings' units; the children the booking form auto-folds under a parent (a
  sole bookable child fills to the parent quantity) are not part of the demand,
  so two selections contending for a shared child pool read as available on the
  gallery and are refused at the form. Advisory-only today (the form is the
  authority — documented in `src/features/public/order.ts`); fixing it means
  loading each option's children in `loadOrderCatalog` and adding the guaranteed
  folded units (and their group pools) to `unitsByListingId`.

- **Per-path sale amounts in the ledger projection.** A booking posts ONE `sale`
  leg per listing (`bookingFactsFromOrder` sums the order's lines by listing id;
  the leg reference is `["sale", listingId]`), and `pricePaidFromLedger` splits
  that total across the listing's sibling rows in quantity proportion. When one
  listing books through two paths at DIFFERENT prices in one order (package
  override beside its own standalone row), the per-row `price_paid` readback is
  therefore quantity-averaged — e.g. 4×400 package units + 1×500 standalone
  reads back 1680/420 instead of 1600/500. Order totals, revenue sums, and
  refunds are exact (the shares telescope); only per-row display/merge
  granularity blurs, and only when per-path prices differ. Fixing it needs a
  SQL-queryable per-path discriminator on sale legs (a transfers schema addition
  — `reference` is a hash, `kind`/`dest_id` feed reports) or re-storing the
  per-row amount. Activation must first migrate and verify old rows in bounded
  pages. Any row that cannot be migrated keeps an explicit reduced-functionality
  state; runtime display and accounting must never fall back to the untagged
  shape. Do it when per-row money display matters more than the schema stability
  of the append-only ledger.

- **Prove every v1 in-flight session is drained before a cutover.** The v2
  schema added `k`/`r` as optional fields to the existing `e/q/p` line shape, so
  old sessions appear to parse as standalone lines. Verify every old-shape
  in-flight case. If any does not qualify, migrate or terminally drain it in a
  bounded, verified pre-activation ceremony. Do not add a runtime parser,
  compatibility bridge, read-through, or old-record branch.

---

## Entity pages migration — slices 4–5

_Origin: `edit-pages.md`._

**Background.** "Entity pages" is one declarative, schema-driven, tabbed
framework (`defineEntityPage`) that replaces every hand-assembled admin "edit X"
page. A page becomes data: tabs of typed sections (summary / activity / actions
/ custom), with per-tab authorization, path-segment tabs, and in-place 400-error
re-rendering. Migration is deliberately gradual and hardest-first.

**Already shipped — do not redo:**

- Framework: `src/shared/entity-pages/core.ts`,
  `src/features/admin/
  entity-pages.ts`,
  `src/ui/templates/admin/entity-pages.tsx`.
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

_Origin: `servicing.md` (+ its review docs `review.md`, `tests.md`)._

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

_Origin: `TEST_QUALITY_IMPROVEMENTS.md`._

**Background.** The goal is to move past coverage-as-floor toward proving
_assertion strength_. The priority-1 initiative — **mutation testing as a gate**
— is fully shipped: `scripts/mutation.ts` + `scripts/mutation/`,
`deno task
mutation` and `precommit:mutation` (staged-file gate, batched to
bound file descriptors — PRs #1478 and others). A weak-assertion audit script
also exists: `scripts/test-quality-audit.ts`.

**Remaining:**

- **Mutation tests removed from `deno task precommit`.** The
  `precommit:mutation` step was too slow for the standard precommit run and was
  removed from `scripts/precommit/steps.ts`. The mutation gate still exists as
  `deno task precommit:mutation` and `deno task mutation` — run it manually on
  changed src/test pairs before merging. Re-wire it into precommit (perhaps
  behind a flag or with a tighter changed-set bound) only if the per-commit
  mutation cost comes down.

- **Property-based tests (item 5).** `fast-check` is currently used in only one
  test (`test/shared/booking/fold-tree.test.ts`). Add properties for: slug
  generation, CSV round-trips (commas / quotes / CRLF), date formatting across
  timezones, token parsers, and URL safety.
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

_Origin: `settings-plan.md`._

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
  alternative supply, and jointly-infeasible cross-slot mixes. All fail SAFE
  (the atomic submit write rejects; capacity is never clamped, only rejected),
  so the cost is a rare dead-end submit or an over-advertised bundle, never
  overbooking. Revisit only if a real configuration hits it.

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

_Origin: the test-suite performance pass (lazy Sentry, fast `toContain`,
migration-suite sharding, `withVirtualBackoff`, `cachedAdminPage`; see the Fast
Tests section of AGENTS.md). These were identified during profiling but
deliberately left for later:_

- **Per-file module-graph evaluation.** Every test file re-evaluates the app's
  module graph (~0.35s each after the lazy-Sentry fix, ~250 files ≈ 80-90s of
  CPU per run). The biggest remaining import-time chunks are `@libsql/client`
  (~65ms, needed) and the `#routes` feature tree (~150ms). Any further
  import-time work moved behind `once()`/dynamic import pays for itself ~250×
  per run — profile with a `performance.now()` probe around
  `import("#test-utils")` under `deno test` before and after.
- **`test/scripts/stripe-mock/ports.test.ts` (~4s)** spawns real child processes
  to test the harness's port handling; each spawn is inherently slow. If it
  grows, the port-conflict cases could stub the child-process layer the same way
  the supervisor tests do.

---

## Capacity rules — feature-layer adoption (stage 3)

_Origin: the capacity-rules consolidation (`src/shared/capacity-rules.ts`)._
Stages 1–2 shipped: the declarative `CAPACITY_RULES` table exists, and the SQL
guard (`src/shared/db/capacity.ts`), the JS preflight
(`src/shared/db/attendees/capacity.ts`, `update.ts`), and the booking-page
limits (`booking/model.ts`, `booking/package-cap.ts`) all derive their
per-date-vs-running-total decisions from it. Stage 3 shipped too: the
feature-layer capacity-date call sites (`ticket-payment.ts` `bookingDateFields`,
`qr-book.ts` `buildCheckoutIntent`, `api/listings.ts` child availability,
`api/booking.ts` `resolveBookingDate`) consult `capacityDateFor`/`countsPerDate`
instead of branching on `listing_type === "daily"` by hand. Only the
_capacity-date_ decisions belong to the table — the remaining calendar/UI daily
branches (date pickers, sorting, display, duration spans) are date-selection
logic and should stay as they are. Nothing further planned here.

---

## Payment aggregate — safety behaviour (PR 1)

New sales and existing payments are now resolved by different questions:
`getActivePaymentProvider()` / `isPaymentsEnabled()` gate new checkouts;
`getPaymentProviderForExistingPayments()` resolves older untagged callback and
completion entry points. When sales are off, that existing-payment path falls
back to the last activated provider. Actual provider refund sends no longer use
that ambient choice: M4's canonical authority carries a tagged provider identity
and passes the complete reference to `loadRefundProvider`, which loads exactly
that adapter and verifies that it matches the tag. That older whole-checkout
resolver must not be called, copied, or consulted as a refund fallback,
including for old rows; an untagged refund reference is a typed permanent
reduced-functionality refusal. The owner handles it directly in the provider
dashboard. No migration, re-save, current/last configuration, credential order,
identifier spelling, or guessed dashboard link may qualify it for the current
refund engine. A site already on `none` recovers when exactly one provider has
stored credentials; when multiple do, the operator must choose the provider in a
recovery form that keeps new sales off. That is a settings activation decision
only; it is not historical payment ownership and cannot be reused by refunds.
`setPaymentProviderNone` reads the current provider via an atomic INSERT ...
SELECT subquery so a concurrent activation cannot land between the read and the
write.

The same no-parallel-path rule binds the future aggregate cutover: either extend
the canonical refund authority in place or fence requests, migrate and verify
all retained rows, switch one epoch, and delete every displaced reader and
writer in the same release. Record age may select migration-only decoding, never
a live legacy engine, read-through, dual write, or fallback authority.

The seven accepted safety rules are recorded as acceptance constraints in
[`docs/payment-aggregate-acceptance.md`](docs/payment-aggregate-acceptance.md).

## Payment aggregate — what the closed rewrite taught us

_Origin: the payment-aggregate rewrite (PRs #1962 and #1973, closed without
merging). Before it closed, the branch went through repeated adversarial review
and a coverage audit. The full record — around forty-five findings, each tied to
a file and line on that branch — is in `TODO.md` at commit `3cf6929b` on
`base/payment-aggregate` (also reachable as `refs/pull/1962/head`). The
table-hardening slice is at `369977cf` (`refs/pull/1973/head`). None of that
branch's code is on main, so the findings are not jobs here — they are the
failure map for the redo the section above plans._

The one finding that applied to main's current code — `performListingDelete`
removing the stored attachment file before the database delete, so a failed
delete batch left a live listing with a dead attachment link — is fixed: the
database delete now runs first, pinned by a fault-injected regression test in
`test/shared/listings-actions.test.ts`.

**Failure shapes the redo must design out.** Each of these was found, and most
were confirmed, on the rewrite. They are worth reading in full at the commit
above before re-attempting the aggregate; in one line each:

- One stuck item must never block the queue behind it: a saved owner decision
  the provider kept refusing halted every checkout, completion and refund; one
  unredactable payment halted all payment-history redaction and the pruning
  behind it.
- "Cannot reach the provider" and "the provider said no" must be different
  outcomes. Collapsing them turned permanent refusals into forever-retries — on
  checkout creation, on refund reads, and on unmapped refund states.
- Deferred work must run from facts saved when the money moved, not from live
  rows an owner may have edited since — quantity, currency, recipient, and the
  booking itself all drifted between capture and completion.
- Every migration copy path needs an answer for imperfect history: a payment
  whose listing was deleted, whose reference lives only on the attendee, or
  whose two provider ids split across pages either failed the whole upgrade or
  silently lost evidence.
- Money-adjacent actions must be exact about their targets: a "refresh" that
  could refund, a refund list that included charge-less payments, and a
  confirmed refund that never reached the ledger all moved or lost money on
  paper.

**Checked against main and not applicable** — recorded so nobody re-raises them
here: SumUp amounts convert once at checkout creation (no stored retry); emails
send inline reading the config at send time (no queue to go stale); the attendee
merge already fences live payment rows (`assertRowsFreeToMove`); Square's
`order_id` is already optional in `src/shared/square/payment-outcomes.ts`; the
success redirect already clears session tokens, and a revisit renders without
them.

**Process lessons for the redo:**

- Build coverage with each slice, not after. The gate wants every line and
  branch covered, guards usually sit in functions the module does not export,
  and CI forbids exports that only tests use — so a guard is only reachable
  through the public entry points, and retrofitting that across twenty-six files
  at once is what kept the rewrite red.
- Keep each PR under about three hundred changed files, or the automated
  reviewer skips it entirely. The other reviewer re-reviews every push and opens
  a fresh thread per finding each time, so answer the newest thread per finding
  and batch pushes.
- The two wording tables in the rewrite's `format.tsx` — every case reason and
  every resource kind keyed to catalog words, so a new one cannot be added
  silently — are the pattern to reuse for payment-case copy.

## Request performance: consolidate AsyncLocalStorage scopes

`src/features/app/request.ts` enters eleven nested request scopes for locale,
client IP, request ID, request cache, query logging, flash, session memoization,
iframe mode, CSRF, saved form data, and settings auditing. Replace them with one
typed `RequestContext` in one `AsyncLocalStorage`; retain domain methods where
they add behavior, but migrate every internal caller with no aliases or
compatibility wrappers. Preserve direct-render test behavior,
production-disabled audit cost, and concurrent/nested request isolation for
every mutable field. Pending work and storage overrides have different lifetimes
and need a separate decision. Benchmark before and after: the synthetic result
was about 38us/request for eleven scopes versus 2us for one. This needs a
dedicated PR because it crosses eleven state modules and their concurrency
contracts.

## Dead-export scanner matches raw text (from PR #1745 review)

`test/scripts/code-quality/detectors.ts` scans raw file contents when deciding
whether an export is used (`IMPORT_CLAUSES` → `isSymbolImported` /
`importedSymbolsOf`, and `isUsedInSameFile`). A clause-shaped snippet inside a
comment, JSDoc, or string literal therefore registers a phantom "usage" — a
CodeRabbit review on PR #1745 pointed out a JSDoc example in that very file
doing this (fixed by rewording the comment), and the fixture strings in
`detectors.test.ts` still contribute contrived names like `routeFoo` to the
test-corpus symbol set. Consequences are mild today: a phantom symbol in the src
corpus can silently mask a genuinely dead export of the same name; one in the
test corpus can only make an export look test-used (which then flags it,
loudly). This is a long-standing property of the whole detector file, not new to
the dynamic-import clauses.

`reverseOf` in `src/shared/ledger/reverse.ts` is a live example of the masking
case. The export has test callers alone, and the `{@link reverseOf}` in its own
JSDoc hides that.

Proposed fix (the reviewer suggested syntax-aware parsing): a code-only
preprocessing pass before matching. The file already has the pieces — the
call-site scanner's `skipString`/`skipComment` lexer helpers skip comments and
string literals correctly. The pass must drop BOTH comments and ordinary
string/template-literal contents from the matchable text (a fixture string
containing `import { foo }` is exactly the stated failure mode), while still
letting the lazyExport clause see its quoted name — lazyExport names live INSIDE
a string literal (`…, "routeAdmin")`), so either match the lazyExport shape
before stripping and stitch its names in, or blank string contents except when
the lexer sees the string directly in lazyExport's second-argument position. Add
regression coverage for import-shaped text in a line comment, a JSDoc block, and
an ordinary string/template literal, plus a lazyExport entry that must still be
detected after the pass. Out of scope for PR #1745 (cold-start work; the
detector change there was collateral hardening) — the concrete self-match it
introduced was fixed in-place instead.

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
is genuinely out of scope for the barrel-removal PR (it would touch far more
than that PR's remit), so it's recorded here rather than done there.

Fix direction: replace the global `toContain` override with `@std/assert`'s
native `assertStringIncludes` (and `assertArrayIncludes` where a `toContain` is
used on arrays), which is already fast — it does not pretty-print on success —
so no `@std` behaviour is patched. Migrate the `expect(bigHtml).toContain(...)`
call sites (thousands, mostly rendered-HTML assertions), then delete
`fast-expect.ts`, its test, the `--preload` flag in both runners, and the "Fast
Tests" note that documents the override. Confirm the suite's slow-test report
(`SLOW_TEST_THRESHOLD_MS`) doesn't regress. Start points: `fast-expect.ts` for
what it did and why, and grep `\.toContain(` under `test/` for the call sites.

---

## Restrictions audit — "why can't I combine X with Y?" follow-ups

_Origin: an audit of every place the app refuses a combination a user might
expect to work, aimed at cutting "why can't I select this?" support queries.
Each restriction was judged on whether its reason is genuinely insurmountable
(structure, money-correctness, capacity, privacy, security) or a soft limit
worth relaxing. The clearest informative wins already shipped — the package
"which listing and why" messages, the daily-add-on "needs a date" reason, the
payment-provider "your other key is kept" note, and the free-text "can't set a
price" note. What's left is captured below, split into rule-relaxations (let the
combination through) and message/UX fixes (keep the rule, stop the user hitting
it blind). All are pre-existing behaviour — deliberate design choices, except
the percentage-surcharge cap noted below, which is a latent correctness bug
(harmless today because of the multiplier workaround)._

### Keep the rule — stop the user hitting it blind

- ~~**SumUp is offered on a currency it can't use.**~~ **Done.** The provider
  registry (`src/shared/payment-providers.ts`) now records each provider's
  currencies (`null` = takes them all), and
  `providerCurrencyBlock(id, currency)` turns that into the one sentence every
  surface shows. The settings page renders an unusable provider switched off
  with the reason beside it, the provider choice refuses to save, and the SumUp
  credentials save keeps its refusal.

- **An answer's price-modifier dropdown silently omits the operator's
  modifier.** `src/features/admin/questions.ts` (`answerTriggerModifiers`) only
  lists `trigger === "answer"` modifiers, so a "+£5" built as _Automatic_ or an
  add-on never appears and reads as a bug. Fix: add a hint by the selector (in
  the answers UI, `src/ui/templates/admin/questions.tsx`) — "only
  answer-triggered modifiers appear here; create one on the Modifiers page."

- **Incompatible listings are offered by the add-listings picker.** The
  group-homogeneity messages now live in the catalog and say why
  (`error.group_*` in `src/locales/en/groups.json`), but the operator still only
  learns of a clash when the save is refused. Better: grey out the listings that
  cannot join this group in the add-listings picker, so the clash is visible
  before saving. The rule to render from is `groupListingTypeError`
  (`src/shared/db/groups.ts`) — same type, and same customisable-days setting,
  as the members already there.

- **Two save-time either/ors would be clearer as disabled controls.** (a)
  customisable-days vs Allow Pay More (`validateCustomisableDays`,
  `src/shared/listings-actions.ts`) — the two fields sit in different form
  sections, so the operator never sees them as related; (b) a paid-default
  status that is also a reservation (`src/features/admin/settings-statuses.ts`
  ~line 69) — both checkboxes render side by side. Fix: mutually disable the
  paired controls client-side with a one-line "why", turning a save-time error
  into an obvious affordance.

- ~~**A multi-item cart with no shared date/length dies silently.**~~ **Done.**
  `src/shared/booking/cart-conflicts.ts` names the clashing items on the ticket
  page — an item with no dates at all, items whose dates never overlap, and
  items with no shared booking length — and tells the buyer to book them
  separately. (See "The shared reasons shape" section below.)

- **A manager hits a bare "Forbidden" on owner-only pages.**
  `src/features/
  auth.ts` (~line 462) returns plain text for
  users/statuses/bulk-email/settings. Fix: ensure the nav hides these for
  managers (the "never render a forbidden link" rule) and give the 403 an
  "owner-only" hint.

- **A child's duration mismatch with its parent is invisible until you open both
  day-price tables.** `children_err_child_duration` / `durationsCompatible`
  (`src/shared/listing-parents-rules.ts`) states the rule but not the clash.
  Fix: surface the actual mismatch at save time ("parent offers 2–3 days; this
  child prices only 1").

- **The order gallery advertises availability it can't honour** once required
  children fold in — already tracked above under _Booking unification →
  "`/order` live availability: fold required-child demand into options"_. Same
  fix; cross-referenced here because it's the buyer-facing half of this audit.

### Relax the rule — let the combination through

- **Only one payment provider active at a time.** `getActivePaymentProvider`
  (`src/shared/payments.ts`) reads a single `payment_provider` setting. This is
  _not_ forced by the webhook — `getWebhookSignatureHeader` already scans every
  provider's signature header — so the block is the single scalar plus no
  per-order provider choice. Relaxing needs checkout-time provider selection,
  header-based webhook dispatch, and a multi-select UI. Reasonable to leave for
  a single-merchant site; revisit if operators ask.

- **A status in use by attendees can't be deleted, with no way out.**
  `src/features/admin/settings-statuses.ts` (~lines 200–221) blocks the delete
  outright. Fix: add a "reassign these N attendees to <status>, then delete"
  flow (the same move already used to retire a default status).

- **The embed widget refuses to add a package to the cart.**
  `src/ui/client/
  order.ts` (~line 489) force-navigates away from a package
  ("it could never combine with other listings"), but the internal cart
  (`src/features/public/
  cart.ts`) _does_ combine packages with listings. Fix:
  add the package slug to the running cart and build a multi-slug
  `/ticket/<slug>+<slug>` URL like the internal gallery.

- **An answer can trigger only one modifier.** `answers.modifier_id` is a scalar
  (`src/shared/db/questions/aggregates.ts`). Everything downstream already
  handles arbitrary modifier sets; only the link is one-to-one. Fix: an
  `answer_modifiers` join table. Low frequency; do on demand.

- **A package can't contain a pay-what-you-want listing.** `packageMemberBlock`
  (`src/shared/package-membership.ts`) blocks it because a package needs a fixed
  member price. Relaxable if you define bundle pricing for a pay-more member
  (use its base price, or let the buyer choose within the bundle) — a semantics
  decision, not a structural wall.

- **A manager can't edit the public site, but a lower-trust editor can.**
  `SITE_ADMIN_LEVELS` (`src/shared/types.ts` ~line 556) is `["owner","editor"]`
  by history. Add `manager` if desired — a pure policy call.

- **Two-level listing nesting (A→B, then B→C).** `childEdgeIneligibility`
  (`src/features/admin/listings-parents.ts`) caps nesting at one level; the
  booking fold-tree and `capacity-rules.ts` both assume exactly parent+child.
  Real work (recursive fold + capacity), not a toggle — build only when a
  concrete booking needs it. (See also the booking-unification phases above.)

- **Child-scoped opt-in add-ons.** An add-on reachable only through a folded-in
  child is blocked because "v1 has no child-scoped add-on render/parse path"
  (`src/features/admin/listings-parents.ts`, `modifier-resolve.ts`). The
  `bookable_alone` flag is the current escape hatch; the real fix is to build
  that render/parse path.

- **The same pay-what-you-want add-on under two parents must share one price.**
  `foldChild` (`src/shared/booking/fold-tree.ts` ~line 281) keys the
  custom-price map by listing id. Per-allocation pricing would allow different
  prices; niche, do on demand.

---

## Surfaces the shared "reasons" shape now makes cheap

_Origin: the package-restriction work (PR #1770), which built the combinator in
`src/shared/reasons.ts` and converged the parent/child edge rules
(`src/shared/listing-parents-rules.ts`), the package member rules
(`src/shared/package-membership.ts`), and the group homogeneity rules
(`groupListingTypeError` in `src/shared/db/groups.ts`) onto it._

Each of these is one rule row plus one surface (see the restrictions audit
above):

- Grey out incompatible listings in the add-listings picker.
- Disable the two either/or control pairs.
- Surface the child-duration clash at save time.
- Warn the operator about the chooser own-cap.

Three decisions bound that work. The i18n keys are the error codes, so no
registry is needed. Fail-fast stays the default for forms, and `allReasons` is
only for a surface that must name every problem at once. An ordinary validation
failure stays out of Sentry: `reportInvariant`
(`src/shared/invariant-errors.ts`) is for a broken system promise, and a new key
gets its `kind` tag only when the flash means "repair the data by hand".

## Deferred Codex suggestions from PR #1975 (API documentation examples)

_Origin: Codex review of PR #1975, which made the API documentation examples
checkable and fixed eighteen real inaccuracies in them. Both items below are
valid and were deliberately left out: they guard mistakes nobody has made yet,
and each costs more machinery than the defect it would catch._

- **Validate admin request fields against their production constraints.**
  `test/shared/admin-api-example/helpers.ts`'s `isBlank` judges a documented
  request value by its sign and whether it is zero. A positive _fractional_
  value (Codex's example: `duration_days: 1.5` in the listing create body)
  therefore passes, while `API_BODY_FIELD_RULES` requires a safe integer and the
  real endpoint answers 400. Fixing it properly means running each request
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

_Origin: CodeRabbit review of PR #1772, which only `git mv`s the servicing
db-module tests into `test/shared/db/attendees/servicing/` (plus a 4-line cwd
fix in `code-quality.test.ts`). CodeRabbit reviewed the moved content as if new
and raised 13 findings; every one is on **pre-existing** test code carried over
unchanged from `main`, so they were out of scope for a rename-only PR and
recorded here._

**Done — the two vacuous tests + the corruption-repair cleanups (a follow-up
PR).** Both suspects were confirmed and fixed:

- `corruption-repair.test.ts` — the `UPDATE … kind = 'staff'` did throw under
  the CHECK and was swallowed by `catch { return }`, so the exclusion assertions
  never ran (confirmed empirically). Now the corrupt row is written past the
  CHECK via `PRAGMA ignore_check_constraints` (libsql supports it), so the
  reader predicates are genuinely exercised — and a separate test asserts the
  CHECK rejects the write directly. The dead `queryOne` import, the
  `string | null` param on `insertRowWithKind`, and the redundant dynamic
  imports were removed.
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

_Nothing remains open in this section._

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

_Origin: the test-suite performance PR (grouped isolates + run-scoped test
state)._

The full runner now shares isolates between test files
(`scripts/test-groups.ts`) and prebuilds the DB setup state once per run
(`test/test-utils/test-state.ts`). The remaining wall-clock tail is a handful of
genuinely long suites, which now bound the slowest groups:

- **Migration chain shards** (`test/integration/db/migration-restore/`, ~20s
  each ×4 shards). They already shard by `index % shardCount`; raising the shard
  count (4 → 8) would halve each shard and shorten the tail groups. Purely
  mechanical — the factory takes the count.
- **Slow-test report entries >2s** (printed after every full run): the
  migration/legacy-migration suites and a few e2e journeys dominate. Each one
  fixed shortens the longest group directly.

Starting point: run `deno task test`, read the slow-test report at the end, and
profile the top entry.

## Pre-existing issues surfaced during the min-tokens-20 dedup (PR #1795)

CodeRabbit flagged these while reviewing the dedup PR. Each is a real point but
pre-existing (the dedup preserved the behaviour, it did not introduce it), so
they were left out of that PR's scope.

- **Bulk email draft cleared after the send, not before**
  (`src/features/admin/bulk-email.ts`, the
  `sendBulkEmails → recordContacts →
  bulkEmailDraft("") → logActivity`
  sequence). `sendBulkEmails` is non-idempotent, so if `recordContacts` throws
  after the send, a retry can resend to the whole audience. Moving the
  draft-clear before the send trades that for the opposite risk (a failed send
  loses the draft with no retry), so it needs a deliberate decision — likely a
  "draft consumed" marker distinct from "draft empty". Not a dedup regression:
  the ordering is byte-identical to before the PR.

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
  hardcoded `successPrefix`/`logPrefix`/tail strings rather than `t()` keys.
  This copy is byte-identical to what lived in `update.ts` on `main` before the
  dedup (the flash string
  `"Updated to … — the new version will be active shortly"` was already there);
  the dedup only moved it into the shared helper. Fix: add ICU keys with
  `{name}`/`{version}` placeholders and pass the two call sites' prefix choices
  as keyed variants, so the flash and log line read from the catalog. Out of
  scope for a dedup PR (pre-existing copy, not a new string).

- **Admin API docs prose is hardcoded, not in the catalog**
  (`src/ui/templates/admin/api-keys.tsx` — the authentication intro
  `"Admin API endpoints require authentication…"`, the
  `"Public API endpoints
  require no authentication. All responses are JSON."`
  line, the admin-group intro
  `"Requires <code>Authorization: Bearer YOUR_API_KEY</code> header."`, and the
  `"Use it with: <code>…</code>"` copy-notice line). These are all present
  unchanged on `main` — the dedup restructured the page onto `DocsSection`/
  `sectionsRenderer` but did not touch the wording. Developer-facing API-doc
  copy may keep literal technical terms, but the surrounding prose still belongs
  in `src/locales/en/*.json` (the sibling `api_keys.public_api_note` already is
  a catalog key). Fix: add `api_keys.*` keys for the four strings, rendering the
  `<code>`-bearing ones via `Raw`. Out of scope for a dedup PR (pre-existing
  copy).

- **The `/api/*/book` docs show a free response for a priced sample**
  (`src/shared/admin-api-example.ts`). Both `POST /api/listings/:slug/book` and
  `POST /api/packages/:slug/book` document their response as
  `API_BOOK_FREE_EXAMPLE_JSON` (`amountOwed: 0`, a ticket token), even though
  the package sample request is a priced bundle whose real response would carry
  a `checkoutUrl` (`API_BOOK_PAID_EXAMPLE_JSON` already exists). Pre-existing:
  on `main` both endpoints used a local `API_EXAMPLE_BOOKING_RESPONSE` const
  that is byte-identical to `API_BOOK_FREE_EXAMPLE_JSON`, and this dedup only
  merged that duplicate into the shared constant — it did not change which
  example shows. Fix (a doc-accuracy pass, not a dedup): pick the example per
  endpoint — a paid response for the priced package bundle, or document both
  free and paid shapes — so the sample response matches the sample request.

## Bunny subrequest budget follow-ups

_Origin: request-fan-out audit for PR #1820._

Bunny stops an edge request after 50 subrequests. The request-scoped guard now
counts database calls and external fetch/storage calls separately and together;
nested allowances reserve mandatory cleanup, and each interactive transaction
keeps one rollback call outside its working allowance. M4 Part A also prices the
EXACT selected admin refund attendee over physical provider retries, database
work, rollback, settlement, and the caller tail before fresh provider I/O. The
cost comes from each stored provider-tagged identity, takes no list of
configured providers, and never becomes zero because credentials are absent;
ambient configuration therefore cannot change refund admission. Refund All uses
a PII-free whole-listing safety summary, then selects one person; its GET
decrypts zero attendee PII, and its POST decrypts zero when blocked/empty or
exactly one when admitted. It does not pretend one request can finish an
arbitrary listing. Blind-index claim expansion separately accepts at most 100
sharing rows outside the selected attendee set and retrieves row 101 only as an
overflow sentinel. Overflow refuses before decrypting shared row state, writing
a claim, or calling a provider. The paths below still have data-dependent
fan-out or need resumable work; counting them makes an overrun loud, but does
not itself make a large operation finish.

- ~~**Package carts and payment completion.**~~ Done. `resolveCartSlugs` now
  resolves every package slug through `loadCartPackagesBySlugs`
  (`src/features/public/groups.ts`) in four reads however long the cart is, and
  `loadPackagePricingByGroup` loads every booked package through
  `loadPackageMemberPricingByGroupIds` in three. `validateAllItems`
  (`src/features/api/payment-processing/items.ts`) reads every order line's
  listing in one batch instead of one call per line. `getPackageDisplaysByIds`
  was already a single query.
- **Outgoing webhook fan-out.** The database side is done:
  `logAndNotifyRegistration` writes every booking's activity row in one batch
  (`logActivities`), and `loadPackageOverrides` prices every booked package in
  one batch. What remains is the sending: `sendRegistrationWebhooks` still
  fetches every distinct webhook URL in the request, so an order spanning many
  listings with different URLs can still run out of Bunny's external-request
  budget. Persist outbound webhook jobs and deliver them out of band.
- **Multi-entry check-in.** `handleCheckinPost` in `src/features/checkin.ts`
  calls `updateCheckedIn` once per eligible booking line. A token set with 51
  lines therefore makes 51 updates. Replace it with one set-based update over
  all attendee/listing pairs.
- **Automatic built-site assignment.** `assignSitesForEntries` and
  `assignSiteWithRenewal` in `src/shared/site-assignment.ts` mix per-unit DB
  writes with provider calls. Eleven Deno site units, or nine Bunny site units,
  can exceed 50. Reserve assignments in one batch, queue provider provisioning,
  and batch-persist the successful renewal states.
- **Old database migration.** `runPendingMigrations` in
  `src/shared/db/migrations.ts` uses at least two marker calls per migration; 25
  pending migrations exceed the limit before their own work.
  `applySchemaChanges` in `src/shared/db/migrations/schema-sync.ts` also runs
  each missing-column ALTER separately. Move long migrations out of band or make
  progress resumable in bounded request-sized steps, and batch safe ALTERs.
- **Large in-app backups and storage cleanup.** After the first-page batch,
  `exportTable` in `src/shared/db/backup-snapshot.ts` still needs one call per
  later page; a 25,000-row table at the default page size needs about 50 pages
  by itself. `cleanupStalePendingFiles` in `src/features/admin/backup.ts` and
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
  permits far more. Move seed generation to CLI/background work or cap the total
  from the request budget.
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

_Origin: CodeRabbit review of PR #1833._

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

_Origin: CodeRabbit review of PR #1836._

`createBackup` batches each table's first page, then `exportTable` reads later
pages with standalone queries. A write during those reads can make a backup mix
rows from different database states. PR #1836 only moves the existing exporter
into `src/shared/db/backup-snapshot.ts`; it deliberately preserves the current
queries, replica routing, pagination, and round-trip behavior.

Add a dedicated read-only transaction or snapshot API in
`src/shared/db/client.ts`. Do not reuse `withTransaction`: that helper opens a
primary-routed write transaction, serializes writers, and enforces a write
round-trip limit. Keep the first-page multi-table read efficient, account for
the edge subrequest budget, and use the same snapshot for every later page. Add
a regression test in `test/shared/db/backup-snapshot.test.ts` that changes rows
between page reads and proves the exported rows all come from one database
state.

---

## Checkout stage attendee cleanup

_Origin: Codex review of PR #1840._

Before any runtime path writes `checkout_stages`, include those rows in attendee
deletion, purge, and merge handling. The table has no foreign key, so leaving
the current hard-coded dependent-table lists unchanged would keep a stage linked
to an attendee that no longer exists. Start with
`src/shared/db/attendees/delete.ts` and `src/shared/merge/attendee-merge.ts`.
Add direct regressions proving deletion removes a stage and merging repoints it
without losing the unique attendee invariant. If both attendees have stages,
require an explicit conflict decision instead of silently choosing or deleting
one.

---

## Test improvements surfaced by PR #1873 (move-only)

_Origin: CodeRabbit review of PR #1873 — "Move eight integration tests to
test/integration/". PR #1873 was a move-only refactor: files were relocated with
`git mv` and only relative import paths were updated. The four findings below
are about pre-existing test code that was already on `origin/main` before the
move; they are recorded here so a future PR can pick them up without re-reading
the review. Each item names the file/path, what CodeRabbit proposed, why it was
out of scope for #1873, and a starting point._

- **Reuse shared `#test-utils` KEK helpers in `test/integration/kek-v2.test.ts`
  (lines 46–92).** `unwrapUserKey` and `ownerDataKey` repeat admin unwrap logic
  that may already live in
  `test/test-utils/{crypto.ts,session.ts,test-state.ts}`. A future PR should
  check whether a shared helper for "unwrap a v2 user's DATA_KEY with the
  per-user-salted password KEK" and "unwrap the shared owner DATA_KEY" already
  exists or should be extracted, then fold this file's local copies into it.
  Keep `seedV1User` local (it constructs a legacy-only fixture) and leave
  `sharesOwnerDataKey` as the spec-specific check. Start by searching
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

- **Assert the computed cutoff in `test/integration/renewals.test.ts` (lines
  187–192).** The test is titled "pushReadOnlyFrom is called exactly once with
  computed cutoff" but only checks the call count via
  `expectReadOnlyFromPush(secretStub)`, discarding the returned
  `{ scriptId, secretValue }`. If the cutoff month math regresses, the test
  would still pass despite its name. A future PR should capture `secretValue`
  from `expectReadOnlyFromPush` and assert it equals `addMonthsIso(baseDate, 2)`
  (the expected quantity-2 cutoff) while keeping the exactly-once assertion.
  `baseDate` is already destructured from `withRenewalTest` in neighbouring
  tests.

- **Assert the error log in `test/integration/renewals.test.ts` (lines
  204–210).** The test is titled "siteToken present but no matching site logs
  error, no Bunny call" but only asserts `expectNoBunnyCall(secretStub)` — the
  "logs error" half of the title is unverified. A future PR should add a
  `console.error` assertion using the existing error-spy helper (search `test/`
  for `spy(console, "error"` or an `errorSpy` helper) so the test verifies the
  error is emitted for the missing site-token match, or rename the test to drop
  the unverified claim. Start by reading `applyRenewalsForEntries` in
  `src/shared/webhook.ts` to confirm it calls `console.error` (or `logError`) on
  a missing site-token match.

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
  `loadScanContext`, `collectLineViolations`, `collectFileViolations`, and the
  path constants would let the test file import them and keep only the
  assertions and per-rule config. Start from the file-discovery helpers already
  at the top of `code-quality.test.ts` (lines 295–360) and the
  `ensureLoaded`/`forEachScannedFile`/`collect*Violations`/`scanSource*` helpers
  inside the `describe("code quality", …)` block (lines 360–540). This is a
  structural refactor (no behavior change); add a regression test that re-runs
  the no-`../` rule against a fixture file via the extracted helpers to prove
  parity with the inline implementation.

---

## Tell the story of a payment whose callback was lost

_Origin: the SumUp recovery work that shipped in #2109 named this story. Nobody
wrote it._

That work named `specs/payments/a-payment-with-no-callback.feature`. The story
must buy through the real public booking page. It must then drop the callback,
run maintenance, and find the ticket.

Dropping the callback is not enough on its own. `createCheckout` sets
`redirect_url` to `/payment/success` beside the `return_url` webhook, and
`processSessionAndRedirect` books the payment from that redirect. A story that
drops only the callback can pass without running recovery at all. The buyer must
reach the success page only after maintenance recovers the checkout.

`test/integration/server/sumup-recovery/recovers.test.ts` covers the recovery
itself, in the case "books a paid checkout whose callback never arrived". It
calls `stageSignedSumupCheckout` and `runSumupRecovery` directly. It does not
buy through the rendered public page, and it does not go through the scheduled
maintenance receiver. The journey as a buyer meets it is therefore untested,
even though each part of it is covered. E2E_TESTS.md gives the user journey to
Cucumber and the technical contract to the integration test.

Start from `specs/payments/recovering-the-money-record.feature` for the house
shape. Start from `recovers.test.ts` for the fixture. Take the maintenance
trigger from `test/features/scheduled/server.test.ts`, because
`recovers.test.ts` calls `runSumupRecovery` directly.

---

## Prove that a replayed Square webhook books nobody twice

_Origin: found during the review of #2132. The slice notes for #2106 said that
the existing idempotency tests already covered this case. They do not._

The replay suites under `test/integration/server/webhooks/` configure Stripe.
`test/integration/server/webhooks/square.test.ts` delivers one webhook and
asserts the retryable answer. No test delivers the same completed Square webhook
twice.

The replay identity of Square is the order id. `retrieveSession` puts it on the
session as `id: order.id`, and that value becomes
`processed_payments.payment_session_id`. A redelivery must therefore reserve the
same row.

To fix:

1. Configure Square.
2. Let the order become readable. Let the payment read back as `COMPLETED` too.
   `readOrderPayment` throws for a completed webhook until it does, so a
   readable order alone keeps both deliveries retryable.
3. Deliver the same completed webhook twice.
4. Assert one `attendees` row.
5. Assert one `processed_payments` row.
6. Assert that no refund was requested at all.

---

## Finish the SumUp recovery race test

_Origin: found during the review of #2132._

`test/integration/server/sumup-recovery/races-the-webhook.test.ts` runs the
webhook and the recovery check together. It asserts one `attendees` row, one
`processed_payments` row, and a state that is not `owed`. It reads no ledger
row, so a race that writes the ledger twice passes it.

The browser redirect is also missing. `late-callback.test.ts` calls the redirect
only after the recovery check finished, so no test runs all three at once.

The request that this work came from asked for two things. The webhook, the
redirect, and maintenance must all attempt the same payment at once. The test
must then prove that the attendee rows and the ledger rows are created exactly
once. Neither half is met yet.

To fix:

1. Read the ledger in the two-way race test.
2. Assert one event group for the payment.
3. Add a case that runs the webhook, the redirect, and the recovery together.
4. Assert one `attendees` row for that case.
5. Assert one ledger event group for that case.

---

## Decide what a buyer sees after the SumUp staging row is pruned

_Origin: the SumUp recovery work that shipped in #2109. The behaviour is read
from the code. No test pins it._

A recovered booking outlives the row that the success page needs.
`validatePaidSession` calls `retrieveSession`, and the SumUp member reads the
staging row through `getSumupCheckout` (`src/shared/sumup-provider.ts`).
`finished` is prunable, so `runDatabasePruning` deletes the row after
`PRUNE_SUMUP_RETENTION_HOURS`. The return then answers "not found".

The ticket is unaffected, because recovery already booked it. The buyer loses
the success page, not the booking.

Two questions sit behind this, and the second waits on the first.

1. Decide whether the success page must work past the retention window.
2. Add a regression test for whichever answer wins.
   `test/integration/server/sumup-recovery/late-callback.test.ts` runs the
   return immediately and never advances the clock, so it proves nothing here.

Two ways exist to keep the page working, and they cost very differently. One
keeps staged rows longer, which costs storage on every site. The other replays
the durable result that recovery already wrote. `processed_payments` holds the
attendee and the encrypted `ticket_tokens` under the same session reference.
`validatePaidSession` asks the provider first, so it answers "not found" before
it ever reads that row.

---

## Mutation coverage of `src/features/api/folded-booking.ts` (direct tests)

Direct tests at `test/features/api/folded-booking.test.ts` and
`test/features/api/folded-booking/parent-booking.test.ts` kill every
non-equivalent mutant on the unchanged `folded-booking.ts`. Five equivalents
(lines 87, 118, 176, 301, 381) are recorded in
`scripts/mutation/equivalent-mutants/` with proofs — no unsuppressed survivors
remain.

## Split `test/shared/db/settings.test.ts` by what each part covers

_Noticed while moving the payment provider settings out of
`src/shared/db/settings.ts` (PR #2114), which took the file from 747 lines to
651._

The file is still one grab-bag over four modules, and well past the 400-line
target. Each `describe` block already names its own part of the split:

- `basic CRUD`, `settings version probe`, and `writeRawBatch` cover
  `settings/raw-writes.ts` and `settings/cache.ts`, which have their own mirror
  files at `test/shared/db/settings/raw-writes.test.ts` and no cache file yet.
- `buildSnapshot via loadKeys` and `loadKeys (on-demand)` cover
  `settings/load.ts`, whose mirror file already exists.
- `setup` covers `settings/setup.ts`.
- `timezone cache` covers the country-derived fields.
- The four `superuserChoice` blocks and `orphan-purge settings` cover plain
  accessors and can share one file.

Move each group to its mirror path under `test/shared/db/settings/`. The
payment-provider move in #2114 is the worked example: the mutation runner picks
direct tests by mirror path alone, so a group that sits in the wrong file does
not run for the source it covers.

## Split `render-selector.test.ts` by what each case actually checks

_Origin: Codex review on PR #1926 (test reorganisation)._

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

_Origin: Codex reviews on PRs #1926 and #1929 (test reorganisation)._

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
`src/features/instance.ts`, `setSiteSecrets` in `src/shared/site-assignment.ts`,
and the per-site loop in `.github/workflows/deploy-clients.yml`.

---

## Split the hybrid encryption section out of `src/shared/crypto/keys.ts`

_Origin: reviewer suggestion on PR #1945._

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
preferences, and bulk email drafts, so every importer needs repointing. Remember
`src/docs/crypto.ts`, which re-exports whole crypto modules for the generated
API docs — a moved export silently disappears from them otherwise.

Starting point: the "Hybrid Encryption" section of `src/shared/crypto/keys.ts`,
and `grep -rn "encryptWithOwnerKey\|decryptWithOwnerKey\|hybridEncrypt" src/`.

---

## Decide what happens to undated bookings when a listing starts being booked by the day

_Origin: found while migrating the multi-day tests to stories (PR for batch 8)._

A listing booked as one date can be switched to being booked by the day. The
people who booked before the switch have no day of their own (`start_at` is
NULL), and the per-day capacity count deliberately excludes them on a daily
listing — see the null-start_at case in
`test/e2e/duration-days/booking-flows.test.ts`.

The effect is that a full listing stops being full the moment it is switched. A
Hall with room for 2, with both places taken, accepts a further booking on any
day after the switch, so it ends up holding 3 people. The listing's _total_
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

_Origin: reviewer suggestion (Codex) on PR #1952._

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

_Origin: reviewer suggestion (Codex) on PR #1959._

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

_Origin: reviewer suggestion (Codex) on PR #1968._

The story `bookings.selling-things-as-one-bundle` proves the _saving_ half of
the blank-price rule: leaving a part's price empty on the bundle form stores no
price of its own for that part. It does not prove the _charging_ half — that the
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

## Watch for ports being taken between tests

_Origin: the chunk that took `scripts/stripe-mock/install.ts` to a full mutation
score (#1966), and the flaky runs it uncovered._

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
for PR #2032 — the latter now hardened: the fixture notes when it wins its port,
and the test retries on a fresh port when that note is missing), and in
`test/scripts/stripe-mock/ports.test.ts` ("keeps a reserved port unavailable
until release", on CI for PR #2114 — the test released its reservation and then
re-bound the same number, which a suite running beside it can take in that
window, so the re-bind now goes through `retryWhilePortTaken`). There is a
second symptom worth knowing about. That test counts how many times the fake
mock was started and expects one start per try asked for. A try whose freshly
picked port already has something listening on it is abandoned _before_ the mock
is started, so the count comes up short and the test fails — even though the
starter did try the number of times it was asked to. Handing out ports so no two
tests can receive the same one would fix this too; short of that, the count is
the wrong thing to measure.

## The Turso upload suite sometimes dies with no diagnostic at all

_Origin: CI on PR #2039, a branch that touches nothing this suite uses. It then
reproduced locally under a full `deno task test:coverage` run, while passing
many consecutive standalone runs — it needs a loaded machine._

`test/scripts/turso-migration-file.test.ts` fails as
`fail Turso migration
file — at unknown location — No TAP diagnostic was emitted for this
failure.`
The first five cases pass and the rest never report, so the whole describe dies
between cases rather than an assertion failing.

The suspect is the watch in `sendDatabaseFile`
(`scripts/turso-migration-file.ts`). When a server answers before the whole body
is sent, Deno's node:http polyfill rejects an internal task nobody awaits
(`Failed to fetch: request body stream errored`), and
`watchPolyfillBodyStreamDefect` swallows that duplicate while the upload is in
flight. The watch stands down one `setTimeout(0)` after the upload settles — its
own comment admits this is a guess about when the duplicate surfaces. On a
loaded machine the internal rejection can land _after_ that one timer turn, and
an unhandled rejection between cases is exactly "no diagnostic, unknown
location". A fix wants a deterministic stand-down — e.g. hold the watch until
the request's own `close` says its internals are done — proven by a test that
forces the late rejection, not by timing luck.

---

## A webhook test about dropped answers fails once in a while in CI

_Origin: CI on PR #2037, a branch that changes no `src/` file at all and does
not touch this test or anything it exercises. The same commit passed the whole
suite locally, this test included._

`finalizes a paid booking when a text-answer ref has no usable string id,
dropping only those answers`
(`test/integration/server/webhooks/custom-questions-single.test.ts`) failed
once, alone, out of 21,686 passing cases.

**What is not yet known is which of its assertions failed.** GitHub's job-log
API keeps only the last 5,000 lines, and the per-case diagnostic falls outside
that window — only the closing summary survives, which names the case and
nothing else. So the first thing anyone picking this up needs is the failure
itself: re-run it under load until it goes, keeping the full output.

Two things are already ruled out. `logError` writes its console line
synchronously before any async work (`src/shared/logger.ts`), so the
`errors.contains(...)` assertion cannot be racing the log it reads. And the
error spy is per-case (`beforeEach`/`afterEach` in
`test/test-utils/error-spy.ts`), so it cannot be picking up a neighbour's
output. That points at the booking or answer-saving assertions rather than the
logging one, but pointing is not proving — do not "fix" this one from the shape
of the test.

---

## Two people setting a site up at the same moment can both succeed

Raised on #1988 by both automated reviewers, and confirmed against the code. It
is a production bug, not a test gap, and it is deliberately left out of that
pull request because that branch changes no production code and this sits in the
most security-critical path we have.

**What happens.** `handleSetupPost` (`src/features/setup.ts`) asks
`isSetupComplete()` and then calls `settings.setup.complete`. Nothing holds
between the asking and the doing, so two requests that arrive together can both
be told the site is empty. `completeSetup` (`src/shared/db/settings/setup.ts`)
then runs its batch twice.

The unique index on `username_index` saves us only when both people pick the
_same_ name. Two different names both insert, and the second batch's
`settingUpsert` calls overwrite `PUBLIC_KEY` and `WRAPPED_PRIVATE_KEY` with a
second keypair. The first owner is left holding a wrapped data key for a data
key the site no longer uses — they can sign in and read nothing.

**Why it is not simply "add a guard".** The batch cannot decide anything
mid-flight, so making the owner insert conditional still leaves the four setting
upserts landing unconditionally. Whatever fixes it has to make the whole
ceremony refuse to run twice — an interactive transaction that re-reads
`setup_complete` inside the write lock, or a single conditional write that every
other statement hangs off. That is a design decision in the code that holds
everybody's encryption keys, so it wants its own change and its own review, not
a corner of a test PR.

**Where to start.** `completeSetup` in `src/shared/db/settings/setup.ts` —
`withTransaction` from `src/shared/db/client.ts` is the tool, and the header
comment on the current batch explains why it is a plain batch today (all values
are computed up front). The guard in `handleSetupPost` at
`src/features/setup.ts:114` stays useful as the cheap first check.

**Proving it.** A story cannot show this today: Cucumber awaits each step, so
the two posts never overlap. #1988 covers the neighbouring case it _can_ reach
honestly — a person who had the setup page open before somebody else finished,
sending their stale form afterwards. A real test for this one needs both posts
started together behind a barrier, and it should be written with the fix.

---

## An answer filed under a listing nobody booked

_Origin: review of PR #1990 (the booking-check slice), 2026-07-29._

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
have been priced and loaded. The natural home is next to `saveSessionAnswers`,
which already has both the answer map and the booked listings — compare the two
sets and raise any key that matches no booked listing, the same way an
unreadable booking is raised.

Start at `saveSessionAnswers`, and at `test/shared/booking-intent.test.ts`,
where the shape rule is covered and the "names a booked listing" rule is not.

---

## A create whose row can't be read back should not look retryable

_Origin: Codex review on PR #2002, which added the loud failure for a create
whose just-written row can't be read back._

`writeEntity` (`src/shared/rest/write-entity.ts`) writes the row, commits, then
reads it back on the primary. When a create's read-back finds nothing it now
raises an error. That error leaves the API write path in
`src/shared/rest/crud-api.ts` and reaches the request handler
(`src/features/app/request.ts`), which turns any unhandled error into the shared
503 page. The row itself was committed, so a client that treats the 503 as "try
again" can post the same create twice and end up with two rows.

The reviewer's suggestion was to read the row back _before_ committing, so a
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

## Record a foreign-currency charge in the money history without pretending it is ours

_Origin: Codex review on PR #2021, which sent a charge taken in the wrong
currency down the existing mismatch-and-refund path._

The money history holds one currency — the site's. When a charge arrives in a
different one, `classify.ts` sends it through the ordinary mismatch flow, and
`storeRefundedBooking` in `src/features/api/payment-processing/store-refund.ts`
writes `session.amountTotal` straight into that history. The number is right but
the currency is not, so a 1,000 yen charge on a pounds site is filed as £10. The
refund itself is unaffected — that goes back through the provider in the
currency it was taken — but the operator's cash history reads wrong, and if the
refund fails it names the wrong amount as still held.

Two ways out: give the money history a currency of its own so a foreign charge
can be filed honestly, or keep these charges out of it and record them somewhere
that does not claim a site-currency total.

Why it is not fixed in that PR: either way changes what the money history can
hold — a stored currency per entry, plus every reader and every total that today
assumes one currency. That is a change to the accounting store, well past a PR
about reading provider money safely, and the wrong thing to bolt on without
deciding which of the two shapes we want.

## Bind a rejected session's refund authority to checkout completion

_Origin: Codex review on PR #2021, which added the automatic refund for a paid
charge the payment boundary cannot read._

M4 Part A closes the actual-send half when fresh evidence is sufficient:
`refundRejectedCharge` carries the callback session id into
`requestProviderRefund`, and the canonical `payment_charges` authority exists
before a provider send. Its unique callback and charge identities prevent a
duplicate send. A malformed or rejected charge whose fresh read is unavailable
cannot supply trustworthy captured Money, so it returns
`withheld`/`read_failed`; no money is sent, but no owner authority row can yet
be created from invented facts. A later callback or browser return is the only
current recovery for that case. A blank reference has no usable identity and is
terminally treated as settled elsewhere.

One sliver moved here from the since-fixed "parked authority" entry: a refunded
rejection whose metadata cannot be read as a booking still stores no Money
target (`settleRejectedCharge` keeps the old behavior for it), so its authority
stays in completed/due until this whole-checkout work lands.

What is still absent is the checkout-completion half. No processed-payment
terminal result links durable refund authority to "this session was refused",
and the unavailable-read case has no durable owner row, so the booking
classifier cannot consult either outcome.

The reviewer's concern is that a later delivery of the same session — a webhook
redelivery, or the buyer opening the success page — could read it in a
well-formed shape, still see it as paid, find no record of it, and make a real
ticket for money that was already returned.

The concrete double-book still requires a provider changing a completed
session's malformed money into a well-formed answer, which is why this is not a
current send-safety fault. The authority already makes refund redelivery safe.
The missing relationship belongs in the atomic M6–M11 cutover's whole-checkout
result and durable completion, so one engine, rather than that provider
assumption, proves the booking cannot later complete.

Starting point: `SessionRejection` already carries the session id;
`refundRejectedCharge` writes the callback identity; M6 must join that identity
to its whole-checkout observation, and M8 must persist the terminal "refused and
refunded" completion result. A later delivery then short-circuits through the
same current engine as an already-processed payment. Do not add a second
processed-payment refund marker.

## Tell a buyer when their money was taken and not (yet) given back

_Origin: Codex review on PR #2021, which added the "your money has been sent
back" page for a charge the payment boundary refused and refunded._

That page is only shown when the refund actually went through. Three other
outcomes still fall back to "Payment session not found", and in each of them the
buyer really was charged:

- A `blank_reference` rejection: the provider says paid but gave no reference,
  so no automatic refund is possible at all. They should be asked to get in
  touch.
- A `malformed_charge` rejection that is paid but whose reference is unusable —
  the same situation, reached a different way (`refundable` is
  `paid && isResourceId(...)`, and the `paid` half is discarded today).
- A refund that has not completed. M4 now persists this in `payment_charges`
  before a validated callback sends and gives it an owner recovery route, so it
  really is in hand. The buyer-facing `RejectionOutcome` still collapses
  `ready`, `pending`, `needs_owner_choice`, and `needs_provider_check` into
  `settled: false` and generic copy instead of saying whether the refund awaits
  the provider or a real owner decision.
- A `withheld`/`read_failed` refund, where the fresh provider read could not
  prove captured Money. No send occurred and, because an authority row cannot be
  populated with guessed money, this case may have no durable owner route today.
  The buyer was reported paid by the rejected checkout observation but has not
  been proved returned.

A fourth case should keep the generic message: a rejection whose price proof
does not verify may belong to another site sharing the provider account, and we
must not tell someone else's buyer anything about their payment.

What it needs: `SessionRejection` carries whether the charge was paid (see
`malformedChargeRejection` in `src/shared/payment/validated-session.ts`, which
computes `refundable` from it and drops it), and `answerRejectedSession` maps
the full `ProviderRefundResult` rather than reducing it to two booleans. Add
catalog copy beside `payment.error.refunded` for captured-with-no-reference and
for durable refund recovery. Foreign price-proof failures keep the generic
answer.

This belongs to the atomic whole-checkout outcome work. Add the copy only from
that engine's exhaustive buyer outcome; do not bolt a parallel response state
onto the legacy rejection path.

## Split the form-control rules into files about one thing each

_Origin: Codex review on PR #2025. Attempted on that branch and backed out — see
below._

`test/specs/support/form-controls.ts` is 478 lines, over the ~400 the repo asks
for, and holds four separate jobs:

- reading a page's attributes (`attribute`, `hasFlag`, `usableInputsOfKind`)
- what a page offers (`chooserFor`, `boxFor`, `choicesOffered`, the checkbox and
  question readers)
- why a value could not be sent (`whyValueCannotBeSent` and the rules under it,
  plus the insisted-control machinery)
- the story-facing helpers (`fillInAndSend`, `takeDownFromActions`)

The first three are pure and the last does the sending, so the natural shape is
`form-controls/reading.ts`, `form-controls/rules.ts`, and a thin
`form-controls.ts` — the same split already done for `test-browser.ts`.

The churn is smaller than it looks: `fillInAndSend` has 15 importers and stays
put, and every reader that would move has between one and five
(`checkboxValueOffered` 5, `tickedCheckboxes` 4, `whyValueCannotBeSent` 3,
`requireCheckboxOffered` 2, `choicesOffered`/`optionsOffered` 1 each). So about
a dozen import lines change. Do not add a re-export layer in `form-controls.ts`
to avoid touching them — that is the alias-export smell the repo rules out;
point each caller at the file that owns what it uses.

**Why it was backed out:** attempted by slicing the file on line ranges, which
produced an unterminated comment, duplicated imports and several unresolved
symbols. Reverted rather than pushed half-done. Whoever picks this up should
move whole declarations (or use an editor that understands the syntax) rather
than cutting on line numbers, and lean on `deno task precommit` — the 214 specs
and the coverage gate both exercise this module hard.

## A form found by its words alone can be sent with no button to press

_Origin: Codex review on PR #2025. Real, and deliberately left for its own
change — see the sweep below._

`findFormByButton` picks a form when the button's words appear anywhere in its
body, then asks `buttonToPress` for the button. When no button matches but the
words do, `buttonToPress` returns `{}` — "no button with that text at all" — and
the form is submitted anyway, with no button data.

That is on purpose for forms found by their body text, and plenty are. But it
means a form whose button is _removed_ still submits if the words survive
elsewhere in it. Site-page deletion is exactly that shape: the heading and the
button both say "Delete Page", so deleting the button leaves the heading, and
the story goes on deleting pages the owner has no control to delete.

The fix is not one line. Refusing every no-button case would break every story
that legitimately finds its form by body text, so the change is to tell those
two situations apart — probably by having the caller say which it expects, or by
only allowing the body-text match when the form has no buttons at all. Either
way it needs a sweep of all 215 scenarios to see which rely on which.

## An arrow is found across the whole page, not on its own row

_Origin: Codex review on PR #2025, raised twice. The second raise carried a case
the first did not, which is why it is here rather than declined._

`canMove`/`move` in `test/specs/support/reordering.ts` look for a row's
`/id/move-up` address anywhere on the page. If that form is rendered against the
wrong row — present, but beside a different item — the story still submits it
and passes, while the organiser looking at the named row sees no arrow.

My first answer to this was that a positive scenario would catch an address
convention changing, which is true but only covers one defect. A form
_relocated_ to another row keeps every address the template tests assert, so
nothing catches it.

Closing it means attributing controls to rows: parse the list into rows and ask
what each row offers, rather than searching the page. `openAtState` in
`statuses.ts` already holds the matched row, so the shape exists — the work is
giving the shared reordering helper the same scope, for every list that uses it
(states, site pages).

### The way _into_ a row is found the same way

_Origin: a third Codex raise, on PR #2025, against `findsTheWayInFrom`._

`findsTheWayInFrom` in `test/specs/support/browser.ts` searches
`row.browser.links` — every link on the page, not the matched row's. Its three
callers all match on something a sibling row could carry:

| Caller          | What it matches                   | Its `openAt` gives |
| --------------- | --------------------------------- | ------------------ |
| `statuses.ts`   | `href === /statuses/{id}`         | the row's markup   |
| `site-pages.ts` | `href` matching `/pages/{id}`     | the row's markup   |
| `api-keys.ts`   | link text plus an address pattern | no row at all      |

Same defect as the arrow above: a link rendered against the wrong row still
satisfies the search, so a deletion journey passes while the person looking at
that row has no way in.

Do it with the arrow, not before it. Two of the three callers already hold the
matched row, but `api-keys.ts` has no row concept yet, so a real fix has to give
every list the row-parsing shape — which is the same mechanism the arrow needs.
Fixing the two that are easy would leave a helper whose scoping depends on which
caller you came from, which is worse than the page-wide search it replaced.

### An equivalence proof rests on types the anchor cannot see

_Origin: Codex on PR #2037, against `descendTo` in
`scripts/mutation/anchor.ts`._

Nearly every reason in the equivalent-mutant registry is a claim about a type:
"`x` is `string | undefined`, so `??` and `||` agree". An anchor fingerprints
the _expression_, so widening `x` to `number | null` leaves the anchor unchanged
and the entry keeps suppressing a mutant whose proof is now false. The entry
only actually hides something when no test distinguishes the two — ignored
status is applied to survivors only, so a killable mutant still reports as
killed — but that is exactly the case the registry is supposed to guard.

Fingerprinting the enclosing function's head was tried and reverted. It costs
more than it buys: adding or renaming any parameter invalidates every entry in
that function's body, and it still misses the majority of proofs, whose types
come from a called function's return, an imported shape, or a database row
rather than the signature overhead. 166 of the 535 recorded reasons name a call,
a return, or a row. A noisy gate that people learn to re-record past makes the
registry less trustworthy, not more.

A real fix has to re-prove entries rather than re-locate them. The most
promising shape is to give `mutation:audit-equivalents` a way to attempt a
distinguishing input for each entry — or, failing that, an explicit re-audit
stamp so an entry has to be re-confirmed after the file it lives in changes
shape, instead of resting on a proof nobody has re-read since it was written.

## Deleting your own contact record also deletes your promotions opt-out

_Origin: found while writing the `attendees.asking-to-be-left-alone` story (the
reader-side unsubscribe journey)._

The "Delete my data" press on `/unsubscribe` calls `forgetContact`
(`src/shared/db/contact-preferences.ts`), which deletes the whole
`contact_preferences` row — including the `unsubscribed` flag. The bookings that
carry the person's (encrypted) address survive, so someone who first
unsubscribed and then asked to be forgotten becomes reachable by the next
promotion again: the send path (`getUnsubscribedHashSet`) no longer finds their
hash.

The story states what the product does today — "the site keeps no record under
that code at all — including the choices they had made on this page" — rather
than softening it. Whether that is the right product behaviour is a real
question with pull in both directions: erasure means erasure, but suppression
lists exist precisely because a marketing opt-out has to survive other
deletions. Settling it means choosing between (a) keeping a bare
`{hash, unsubscribed}` row behind on forget, (b) wording the page's
`unsubscribe.forget_explainer` to say promotions may resume, or (c) leaving it
as is, deliberately. Starting points: `forgetContact`, the forget branch in
`src/features/public/unsubscribe.ts`, and the story's
`@rule:attendees.the-record-under-their-code-can-be-deleted`.

## Move the unsubscribe flash wording into the message catalog

_Origin: the same story migration._

The three flash messages the `/unsubscribe` POST sends back ("You've
unsubscribed from our marketing emails.", "You've resubscribed to our marketing
emails.", "Your contact record has been deleted.", plus "That link is invalid.")
are string literals in `src/features/public/unsubscribe.ts`. The `i18n-coverage`
gate only scans templates, so nothing flags them, but they are user-facing copy
and belong in `src/locales/en/unsubscribe.json` like the rest of the page's
words — then the story steps and the direct pins in
`test/integration/routes/unsubscribe.test.ts` can assert them through `t()`
instead of pinning copied wording. Out of scope for the migration, which does
not touch `src/`.

## Make Refund All a durable, resumable intention

M4 Part A made one interactive request safe and bounded. `getRefundAllSummary`
(`src/shared/db/refund-all-candidates.ts`) checks the whole listing through
indexed, PII-free facts and refuses a visible review, unrecorded-money marker,
or canonical `provider_refund` blocker on any attendee who is still part of the
refundable set, and also refuses a non-empty processed reference whose blind
index is blank. The blocker check runs before selection, so an unsafe candidate
anywhere in the refundable set still closes the command. A settled
non-candidate's independently protected work does not strand an unrelated
refund. `loadRefundAllBatch` then selects one person, with claimed work first;
the exact claim decision later distinguishes a live run from recoverable stale
work. Opening Refund All decrypts zero attendee PII. Posting it decrypts zero
when the summary is blocked or empty and exactly that one selected blob
otherwise; no route decrypts a candidate array and slices it afterwards. Typed
admission also refuses a selected person's current PII payment id when no
indexed row carries it. The exact selected attendee goes through the same claim
and physical provider/database budget as a single refund. It either refuses
before fresh provider I/O or processes that person and reports how many
candidates remain. Another form submission takes the next person. This
one-attendee size follows the proved Bunny envelope for the maximum accepted
reference set; up to five provider calls may overlap within that attendee.

What remains is durability of the WHOLE-LISTING intention. A crash after page
one leaves every untouched attendee discoverable, but no stored job says that
the owner asked to continue, and nothing resumes it automatically. M7 must
persist the immutable provider-qualified payment identities and a cursor before
the first send. Each bounded request records every item result and advances only
past terminal items; transient failures stay due, permanent refusals become
owner work, and a visible job always names the unprocessed remainder. Reuse M4's
summary, exact attendee claim, budget checkpoints, and settlement; do not add a
second bulk engine or a generic clear that discards money facts.

## Historical refund references deliberately remain manual

_Product decision recorded during PR #2065 review._

There is no migration task to restore current in-app refund controls for old
PII-only, blank-index, or provider-untagged references. The small installed base
does not justify a second refund path, a whole-table decrypt, or code that will
outlive the events those bookings belonged to. The owner refunds one of these
payments directly in Stripe, Square, SumUp, or the relevant provider.

`attendees.pii_payment_session_id` makes completeness visible without opening
PII: `NULL` means historical or otherwise unqualified, `''` proves the PII had
no payment id, and a non-empty value names the exact indexed processed-payment
session that proves it. Normal paid booking and automatic-placeholder creation
write that proof in their existing all-or-nothing transactions. A later balance
does not replace it. Merge propagates a source `NULL` to the target in the merge
transaction, while a qualified source preserves the target marker; deleting the
source therefore cannot hide older unknown history. Pruning retains the exact
processed row named by a non-empty marker.

Single Refund, Refresh, and Refund All fail before provider I/O when the history
is unqualified. Refund All proves this from indexed SQL and ledger facts before
selecting or decrypting a person, including the mixed case where a PII-only
deposit sits beside a newer indexed balance. Re-saving an attendee does not
qualify the row. Do not add a runtime fallback, background backfill,
migration-only attendee-PII reader, guessed provider binding, warning-note
authority, or parallel legacy refund engine.

The future aggregate copy may preserve SQL-visible accounting facts from these
rows as terminal unsupported history. It must not search attendee PII or old
free-text notes for another payment reference, and it must not turn an
unsupported record into an actionable canonical charge. Historical plaintext
references and old DB-key-encrypted notes remain retirement/redaction concerns,
not inputs to current refund admission.

## A merge can delete the source before the answers and PII are saved

`applyAttendeeMerge` (`src/shared/merge/attendee-merge.ts`) commits the source
delete, the payment-row move, and the ledger repoint in one transaction — but
`saveAttendeeAnswers` runs after that transaction commits, and
`updateTargetPiiFromDecision` runs later still, back in the route
(`src/features/admin/attendees-merge.ts`). A failure in either leaves the source
attendee already deleted with the merged answers or PII never written. The
answers are recoverable only from the deleted source, so they are gone.

The fix is the one CodeRabbit names: open one `TxScope` for the whole merge and
thread it through the payment-row batch, `saveAttendeeAnswers`, and
`updateTargetPiiFromDecision`, committing only once every write has succeeded.
The transaction handle now exists — the merge became an interactive transaction
when the payment-row admission landed — so this is threading it outward rather
than introducing one. The awkward parts are `saveAttendeeAnswers`, whose
delete-then-insert re-encrypts free-text answers, and the PII update, which
needs the request private key and currently sits in the route.

Out of scope where it was found: that slice was the merge/delete payment
admissions, and this ordering predates it — the old code committed the same rows
in one `executeBatch`, which is the same boundary. Worth doing on its own, with
regression coverage that fails each post-batch write and checks the source
attendee, payment rows, ledger rows, answers, and PII are all still as they
were.

## Give shared and merged charges authoritative bookkeeping

`claimAttendeeRows` expands a claim to every row carrying the reference, and
`runRefundReadiness` writes an exact `shared_reference` review marker and stops
before provider or ledger I/O. One payout cannot be reversed once per holder.
The current owner action is only an acknowledgement: it stamps `acknowledgedAt`
on the exact review case while preserving the marker and its safety hold. It
records no allocation, so an unchanged shared representation stays blocked; the
marker retires only when a later indexed claim proves the representation is
unique.

That expansion is bounded in the current path. A claim accepts at most
`MAX_SHARED_PAYMENT_ROWS_PER_CLAIM` (100) rows outside the selected attendee
set; its SQL reads at most 101 and treats the extra row only as proof of
overflow. The typed `too_many_reference_holders` result reaches Refund and
Refresh as finite operator copy before any sharing row's encrypted
`failure_data` is opened, before any claim is written, and before provider or
ledger I/O. Never replace that refusal with truncation: an incomplete holder set
would make the one-payout guarantee false.

The application has never intentionally assigned one provider payment id to two
independent historical attendees, so do not add a whole-table holder scan or
decrypt old attendee PII for a hypothetical legacy sharing case. The real case
to model is a MERGE or booking obligation that gives one captured charge more
than one local representation or obligation.

Build stable booking obligations plus a revision-fenced allocation. Every part
is positive Money in the captured currency, the parts sum exactly to the
capture, and the owner may explicitly reject the allocation. There is no equal,
proportional, first-attendee, or current-row default. The stored allocation is
the one authority for later cash and ledger effects. Merge preserves that
authority and cannot turn source and target representations into two payouts or
two reversals.

Returning cash and cancelling a booking obligation are separate effects. When
one payment returns while another payment for the obligation remains captured,
require a revision-fenced owner choice with no default: keep the booking and
make the return due, return all remaining cash then cancel, or cancel now while
retained cash remains visible refund work. Until that choice exists, the
returned row carries exact `unrecorded` work plus a
`partially_returned_obligation` review reason; the review reason is not an
`unrecorded` kind. It never cancels a sale it did not fully fund.

Do not lose the anchor-only version of this fault. A synthetic `legacy:` anchor
has no real payment-session id, so `refund-ledger/plan.ts` cannot place it onto
a specific booking or balance event group. If that attendee's account also
contains operator money (`manual_*` or `adjustment`) or a partly paid
obligation, the ledger can prove that an automatic reversal is unsafe but cannot
attach `partially_returned_obligation` to the anchor through its empty
placement. Treating that as generic unrecorded cash would expose the wrong
"Money is recorded" exit without the required booking decision. The stable
allocation must map the charge to its obligation, or preserve an explicit
unallocated conflict; never infer the mapping from row order, the attendee's
whole account, or the number of unnamed groups.

Start at `sharedRepresentations` in `src/shared/db/payment-claim/take.ts`,
`runRefundReadiness` in `src/features/admin/refunds/readiness-run.ts`, the
payment-row repoint in `src/shared/merge/attendee-merge.ts`, and the exact
result sets in `src/shared/refund-ledger/{plan,result}.ts`. Test an anchor-only
return beside manual money and beside a partly paid booking, a shared charge
across two attendees, a merge that creates two representations on one attendee,
rejection, an exact multi-obligation allocation, and every partial-obligation
owner choice.

## Build whole-checkout diagnosis with the reader that can feed it

M4 Part A intentionally judges only `ChargeMoney`: one charge's captured,
returned, and in-flight refund facts. It does not carry the signed expected
total, session ownership, all captured charges, or provider-specific child
resources, so it cannot honestly diagnose wrong parents, duplicate charges,
money on a free checkout, or allocation across booking obligations.

M6 must introduce the whole-reading cluster together with its production reader:

- a normalized payment observation with signed/staged ownership proof and the
  complete provider read;
- session, charge, charge-leg, and whole-resource schemas, including every
  provider-specific sibling read that the declared evidence shape requires;
- one whole-payment `outcomeOf` that validates ownership, resource uniqueness,
  parentage, currency, expected Money, capture total, and free/paid state; and
- the stored conflict kinds that this real reading can produce, with their owner
  action and retirement in the same slice.

Preserve the current Square boundary nuance in that reader: a non-empty
`_origin` is an application marker for distinguishing a damaged app checkout
from an unrelated order, even after the site's hostname changes. It is not site
ownership proof and must not be compared with the current hostname; the signed
`price_proof` remains the ownership fact. Reintroducing host equality would
terminally misclassify an older damaged checkout as foreign.

Preserve the other live Square boundary too: payment webhook status is exactly
`APPROVED | PENDING | COMPLETED | CANCELED | FAILED`. Missing, non-text, empty,
or unknown values throw; only a known non-completed status may be acknowledged
without processing, and `COMPLETED` requires an Order id. That declaration is
`webhookPayment` in `src/shared/square-provider.ts`, written as bare throws
rather than a schema, and it is the one webhook door the provider fold left
hand-rolled. M6 must reuse or replace it atomically, never leave a permissive
legacy webhook parser beside its observer.

Reads must be bounded and fenced on an evidence revision or fingerprint. A
provider-controlled sibling list cannot cause an unbounded request; evidence
beyond the declared cap becomes an explicit owner case. Do not restore a
speculative module set wholesale or put a second refund classifier beside
`refundOutcomeOf`: design the vocabulary from the reader inward.

`PaymentConflict` is only a TypeScript type, not persisted schema authority. The
stored `PaymentReviewReasonSchema` currently contains only `shared_reference`
and `partially_returned_obligation`; provider disagreements that already have
trustworthy refund authority live instead in the canonical `payment_charges`
union. Exact zero or full return may live in `needs_owner_choice`, whose schema
guarantees at least one evidence-supported answer. Partial, invalid, backward,
wrong-currency, excessive, or pending evidence lives in `needs_provider_check`,
which offers only another provider observation. Fresh partial evidence replaces
an ordinary ambiguous choice and advances the revision, so a stale not-sent form
cannot erase it; a conclusive conflict choice is not rewritten by a later read.
The current exact decision comes from `payment/refund-conflict-decision.ts`;
stored schemas and mirrors live in `payment/refund-authority-state.ts`;
automatic transitions in `payment/refund-authority.ts`; conflict and owner
transitions in `payment/refund-authority-choice.ts`; lifecycle exits in
`payment/refund-authority-lifecycle.ts`; identity writes and Money/state writes
are the one logical authority split across `db/provider-refund-authority.ts` and
`db/provider-refund-authority-change.ts`; and
`db/provider-refund-case-resolution.ts` commits a decision with its activity
audit. Every rendered action carries the authority id and revision: a stale Send
loses before provider I/O, a money choice loses inside its transaction, and
Check again is observe-only with a stale-form precheck plus transition CAS. Any
newly reachable M6 conflict kind must extend those canonical mechanisms with its
schema, required owner action, and tested retirement path in the same atomic
cutover. Do not revive the deleted module cluster or create a second refund
classifier/state machine.

That cutover is an atomic replacement, not a runtime selector. Every checkout
caller moves to the new observer and completion authority in the same activation
that deletes the displaced readers and writers. No fallback, read-through, dual
write, second refund authority, or old-record branch may remain in request code;
old-format decoding exists only inside the fenced migration ceremony. This rule
also governs every later refund-authority evolution: extend the one authority in
place or make the same fenced migrate/verify/epoch-switch/delete cutover. Never
ship an intermediate compatibility path, even temporarily.

## The stale-claim touch test is timing-flaky on CI

`test/scripts/stale-claim/touching.test.ts` — "touches the claim on time, so it
never reads as walked away" — failed once on a loaded CI runner (PR #2065, run
31448224401) and passes reliably locally. It is the file lock that stops two
mutation runs sharing `.mutation-runs/`, not the payment claim, despite the
shared word.

It is fragile because it mixes three clocks: a `FakeTime` it ticks with
`time.tickAsync(5)`, a real `Date.now() - 40` written into the record, and real
disk writes it then polls for with `eventually()`. The fake clock does not move
`Date.now()` in the record, so the margin between "aged 40ms" and the 25ms
freshness window is real wall-clock time, and a runner that stalls between the
write and the poll can miss it.

The fix is to take the wall clock out of it: have the test age the record
against the same fake clock it ticks, rather than against `Date.now()`, so the
margin is deterministic. Out of scope where it was found — that session was
closing the M4 coverage gaps and this file is mutation-run tooling.

## Refunded status cannot tell two orders on ONE listing apart

_Origin: Codex and CodeRabbit, both on PR #2065 (partial ledger reversal)._

`refundedForBooking` (`src/shared/db/attendees/select.ts`) answers "did THIS
booking come back" per (attendee, listing): a sold booking that came back has a
`refund_sale` leg running revenue → attendee. That fixed the severe case — one
returned charge used to mark every booking the person held, so the scanner and
check-in turned them away from events they had paid for.

What is left is narrower: one attendee holding TWO orders for the SAME listing
(a merge of two people who both booked it, or two dates). Reversing either makes
both rows read refunded. This is not new — before the per-listing fix the whole
account read refunded — but it is now the only remaining case.

Both reviewers proposed scoping the predicate by
`listing_attendees.
ledger_event_group`. That does not work as suggested: a
reversal leg's `event_group` is `refundEventGroup(bookingGroup)` and its
`reference` is `legReference([REFUND, bookingGroup, ...])` — both HASHES, so SQL
cannot join a reversal back to the booking group it reversed. The sale side
could be scoped; the reversal side could not, which leaves both rows reading the
same answer.

Two ways out, both real work:

- Populate `reverses_id` on refund legs in `mapRefund`, giving a joinable link
  from each reversal to the leg it reverses. This contradicts decision 8 ("a
  refund posts many rows and repeat/partial refunds are scoped by event group
  instead"), and existing plus backfilled refund legs carry no `reverses_id`, so
  activation requires a bounded, verified backfill. Any unmigratable historical
  row must remain explicitly unsupported; no runtime fallback is permitted.
- Add a column naming the reversed booking group, with the same bounded,
  verified migration and explicit unsupported state for unmigratable history.

Start by reading `mapRefund` in `src/shared/accounting/mappers.ts` and the
`reverses_id` note above it.

### A free member of a paid package is never marked refunded

_Origin: Codex on PR #2065, `select.ts:86`. Same root cause, worth doing in the
same pass._

`mapBooking` drops zero-value legs
(`facts.lines.filter((line) => line.gross >
0)` in `bookingLegSpecs`), so an
explicitly-free member of a PAID package has no sale leg of its own.
`refundedForBooking` then falls through to `ELSE 0` and the row stays live after
the whole package order — including its paid member's sale — has been reversed.
The scanner and check-in keep accepting that ticket.

The obvious fix — "did any booking sharing my order group come back" — is NOT
safe on the data as it stands, and this is the trap to avoid:
`ledger_event_group` is stamped per ATTENDEE, not per order. Both
`postBookingLegsTx` (`src/shared/checkout-complete.ts`) and the backfill's
`stampStatement` (`src/shared/accounting/backfill.ts`) write it with
`WHERE attendee_id = ?`, so an attendee's second order overwrites the first
order's rows. Correlating on it would let one order's refund mark a DIFFERENT
order's booking as refunded — turning someone away from an event they paid for,
which is the bug the per-listing fix just closed.

So this needs the order key made per-order first. That is the same dependency
the two options above have, which is why it belongs with them: fix the key, and
the free-package-member arm and the two-orders-on-one-listing case both become
expressible. Note the same weakness applies to `pricePaidFromLedger`, which
already keys on this column.

Do not conflate that deferred booking-order identity with payment retention.
PR4-A closed the sibling-pruning fault independently: an old referenced row may
age out only when its exact blind reference index matches a completed,
locally-recorded canonical charge. An attendee-wide `refund_cash` leg or a
returned sibling charge is never deletion authority. Keep that exact-charge rule
when the stable obligation model replaces the current booking projection.

## The stripe-mock start-count test read a port somebody else had taken — fixed

`test/scripts/stripe-mock/lifecycle.test.ts` — "stops trying once the mock has
been started as many times as asked" — failed on CI twice on commits that
changed only Markdown (PR #2065 run 31501332067, and PR #2104 run 32130150568 at
24,020 of 24,021 passing), and passed reliably locally.

**The first diagnosis recorded here was wrong**, and it is worth keeping the
correction. It said the parent read the count file before the last `/bin/sh` had
appended its line. It cannot: a failing attempt ends at
`await stopProcess(spawned.process, ...)`, and `stopProcess` awaits the child's
`status` on both of its branches — `beforeTimeout` resolves when the status
does, and the timeout branch awaits it after the SIGKILL. Every spawned child
has therefore exited, and written, before `startStripeMock` rejects.

The real cause is a stolen port. `attemptStartStripeMock` has exactly one early
return before it spawns: the port is already listening, so an unpinned attempt
gives up and asks for another. `withUnusedPort` picks a free port and lets go of
it before the start binds it, so another suite can take it in between — and that
attempt never spawns, so the count comes up one short. The sibling test at
"gives a mock time to shut itself down" already guarded against exactly this
with `retryWhilePortTaken`; `triesBeforeGivingUp` did not.

`triesBeforeGivingUp` now takes the count it wants and retries on a fresh port
while it comes up short, over the same shared helper. `retryWhilePortTaken`
takes an optional description, read only once every try is spent, so a run that
never gets a clean port reports what it actually saw.

## A schema migration between the two payment-record migrations can stop an upgrade

_Origin: Codex review on PR #2065 (thread on
`src/shared/db/migrations/registry.ts`)._

`2026-08-10_refund_authority_records` drops the dormant payment tables before
its own apply, because `applySchemaChanges`
(`src/shared/db/migrations/schema-sync.ts`) reconciles the WHOLE current schema
and can only `ADD COLUMN` — and SQLite refuses to add a `PRIMARY KEY` column.
That guard protects only `2026-08-10` itself.

A site that ran an intermediate build of this branch (one carrying
`2026-07-26_payment_records` but not `2026-08-10`) holds a `payment_charges`
without the `id` primary key. On upgrade, `2026-08-04_login_attempt_stamp` — a
`schemaMigration` registered BETWEEN the two — runs `applySchemaChanges` first,
which scans the whole schema and emits
`ALTER TABLE payment_charges ADD COLUMN id INTEGER PRIMARY KEY AUTOINCREMENT`.
SQLite rejects that, and the upgrade stops before `2026-08-10` can drop the
table. Every migration between the two payments migrations has the same shape of
risk; only the site's own position in the chain decides whether it bites.

The migration chain tests cannot see this: replaying historical migrations uses
the CURRENT schema at every step, so a test "from 2026-07-26" creates
`payment_charges` in its final shape and never reproduces a deployed
intermediate shape.

Fix options: move the dormant-table drop into the earliest migration that would
otherwise ALTER them (or into `2026-07-26` itself, dropping its own tables when
they exist in a foreign shape), or give `schemaMigration` a per-migration table
scope so intermediate applies never touch tables the migration does not declare.
The empty-rows guard in `clearDormantPaymentTables` is the model for the drop;
keep the loud refusal on non-empty tables.

## Split the three oversized e2e-payments files

_Origin: a self-review of PR #2116 against AGENTS.md._

Three harness files are above the ~400-line guideline, and two of them crossed
it in that pull request:

| File                                         | Lines |
| -------------------------------------------- | ----- |
| `e2e-payments/src/cucumber/steps/booking.ts` | 484   |
| `e2e-payments/src/browser.ts`                | 430   |
| `e2e-payments/src/flow.ts`                   | 404   |

The splits are already visible in the code. `browser.ts` carries the
click-witness helpers (`armClickWitness`, `armWitnessedAttempt`, and the
`Witnessed` shape) above `launchAppBrowser`, and they depend on nothing else in
the file, so they move to their own module whole. `booking.ts` carries the
webhook-evidence block (`WEBHOOK_DID`, `WEBHOOK_HELD`, `callbackLine`,
`webhookEvidenceThen`), which is one concept and reads as one. `flow.ts` is four
lines over, so it needs no split of its own once the ledger reader has somewhere
better to live.

Do this when the harness is next open for other work, so the split lands with a
real run rather than on its own.

## Give the live payment harness direct tests through injectable seams

_Origin: the coverage-exclusion thread of the Codex review on PR #2065._

The harness modules under `e2e-payments/src/` are excluded from coverage
wholesale in `scripts/run-tests.ts`, with the reasoning recorded beside the
list; only the pure helpers stay covered. The durable fix is the one Codex names
— push the env/config parsing behind injectable seams so those branches get
direct in-process tests. The twelve behaviour findings from the same review
round are fixed; this remaining item is the test-architecture half.

## Deleting your own contact record also deletes your promotions opt-out

_Origin: found while writing the `attendees.asking-to-be-left-alone` story (the
reader-side unsubscribe journey)._

The "Delete my data" press on `/unsubscribe` calls `forgetContact`
(`src/shared/db/contact-preferences.ts`), which deletes the whole
`contact_preferences` row — including the `unsubscribed` flag. The bookings that
carry the person's (encrypted) address survive, so someone who first
unsubscribed and then asked to be forgotten becomes reachable by the next
promotion again: the send path (`getUnsubscribedHashSet`) no longer finds their
hash.

The story states what the product does today — "the site keeps no record under
that code at all — including the choices they had made on this page" — rather
than softening it. Whether that is the right product behaviour is a real
question with pull in both directions: erasure means erasure, but suppression
lists exist precisely because a marketing opt-out has to survive other
deletions. Settling it means choosing between (a) keeping a bare
`{hash, unsubscribed}` row behind on forget, (b) wording the page's
`unsubscribe.forget_explainer` to say promotions may resume, or (c) leaving it
as is, deliberately. Starting points: `forgetContact`, the forget branch in
`src/features/public/unsubscribe.ts`, and the story's
`@rule:attendees.the-record-under-their-code-can-be-deleted`.

## Move the unsubscribe flash wording into the message catalog

_Origin: the same story migration._

The four flash messages the `/unsubscribe` POST sends back ("You've unsubscribed
from our marketing emails.", "You've resubscribed to our marketing emails.",
"Your contact record has been deleted.", plus "That link is invalid.") are
string literals in `src/features/public/unsubscribe.ts`. The `i18n-coverage`
gate only scans templates, so nothing flags them, but they are user-facing copy
and belong in `src/locales/en/unsubscribe.json` like the rest of the page's
words — then the story steps and the direct pins in
`test/integration/routes/unsubscribe.test.ts` can assert them through `t()`
instead of pinning copied wording. Out of scope for the migration, which does
not touch `src/`.

## Pin the mirror pair with a table check when processed_payments is next rebuilt

_Origin: the PR #2084 write-site sweep._

`processed_payments` should promise
`(protected_state = '' OR failure_data !=
'')` — a live-work mirror can never
exist without the stored state it mirrors. Deeper checks are impossible because
`failure_data` is encrypted; this weak form is the whole expressible invariant.
Every current writer already keeps it by construction (`paymentRowStateValues`
in `src/shared/db/payment-claim.ts` writes the pair together, and
`reserveSession` derives its blank pair from the same builder), so today the
check would only guard against a future rogue writer. Adding it to an existing
table needs a full table-rebuild migration of a money-adjacent table across
every site — the riskiest change class we ship — which is not worth it for a
state nothing can currently produce. If a real schema change ever rebuilds
`processed_payments` anyway, add this check in the same rebuild: the DDL belongs
on the last column via the `alsoAbout` pattern in
`src/shared/db/migrations/schema/payments/columns.ts`.

---

## One admin form POST helper, not three

_Origin: widening `adminFormPost` to accept repeated fields (PR #2115)._

`adminFormPost` in `test/test-utils/session.ts` now takes the same
`TestFormValues` its underlying `mockFormRequest` always accepted, so it can
post a repeated field such as `user_ids`. That makes two local helpers close to
redundant: `adminPost` in `test/features/admin/groups/helpers.ts` (13 call
sites) and the `adminPost` in `test/test-utils/servicing.ts`. Each signs in,
adds the CSRF token, and posts a form.

The two differ from the shared helper in small ways. `adminFormPost` also loads
the settings keys and sends `settings_version`, and it returns the cookie and
the token beside the response, where the local helpers return the raw
`Response`. Fold the call sites onto `adminFormPost` and delete the local
helpers, rather than leaving one operation with three names. Do it in its own
pull request, because a form that starts sending `settings_version` can change
what a version-guarded save does.

Starting points: `test/test-utils/session.ts:402`,
`test/features/admin/groups/helpers.ts:19`, `test/test-utils/servicing.ts`.

---

## The roster CSV ignores the order you chose

_Origin: the consolidation review of recent provider and admin work._

The roster page and its CSV export read the same address bar through
`readAttendeeListState`, but only the page acts on the `sort` it finds.
`listingRosterView` in `src/ui/templates/admin/listings/roster.tsx:52` orders
the rows with `inRegistrationOrder(sort)`, and hands the table `presorted: true`
so the table keeps that order. The export goes through
`filteredAttendeesHandler` in `src/features/admin/listings-view.ts:104`, whose
`FilteredAttendees` context carries `checkin`, `dateFilter`, and
`filteredByDate` and drops `sort`. Neither `handleAdminListingExport` nor
`generateAttendeesCsv` orders the rows again.

Two effects follow. A staff member who picks "oldest first" and then downloads
the CSV gets the raw database order. A staff member who picks no order at all
also gets the raw database order, because the table applies its own
date-and-name order in the browser and the CSV never does.

Fix: put `sort` on `FilteredAttendees`, apply the same `inRegistrationOrder`
step the page applies, and apply the table's default date-and-name order when
`sort` is null, so the two surfaces cannot disagree. The comment above
`filteredAttendeesHandler` already promises that "the CSV export mirrors the
on-screen table", so the comment is correct and the code is not. Ship a
regression test that exports with a chosen order and pins the row order.

---

## The migration runner asks one scope and reads another

_Origin: the consolidation review._

`runPendingMigrations` in `src/shared/db/migrations/runner.ts:196` decides
whether to cap the run with `isDatabaseRoundTripLimited()`, which reports
whether the **query-log** scope is open (`queryLogScope.current() !== undefined`
in `src/shared/db/query-log.ts:77`). It then computes the cap from
`getSubrequestRemaining()`, which reads the **budget** scope in
`src/shared/subrequest-budget.ts:40`. The two are separate `createScope` stores.

Today the one production path enters both together, in the scope list in
`src/features/request-scopes.ts`, so the answer happens to be right. Nothing
holds them together. A caller inside the query-log scope but outside the budget
scope reads the `BUNNY_SUBREQUEST_LIMIT` defaults and caps against a budget it
does not have. A caller inside the budget scope alone applies no cap at all.

Fix: ask the budget scope directly. Export a "is there a subrequest budget"
reader from `src/shared/subrequest-budget.ts` beside `getSubrequestRemaining`,
and let the migration runner ask that one counter. Pin it with a direct test
that opens the budget scope without the query-log scope.

---

## One provider credentials form

_Origin: the consolidation review._

Square's settings form skips the shared block and re-spells two element ids that
the shared footer already generates, so the three provider forms drift. Fold
them onto one `ProviderCredentialsForm` driven by the provider registry in
`src/shared/payment-providers.ts`. About 50 lines.

---

## Fold B, one source of route facts

_Origin: the consolidation review._

The mechanism exists and is proven. `formGuardAt` and `pageGuardAt` in
`src/features/admin/crud-handlers.ts:108` read their roles from
`adminDestinationAt` in `src/shared/admin-surface.ts:62`, so the roles are
written once in the admin surface declaration.

- **Declare the 98 undeclared write routes.** Every GET route declares who may
  reach it, and a test enforces the declaration. 98 write routes take their
  roles from the handler alone, and nothing compares the two. This is the one
  item on the list that adds lines, about 110 of them, because it buys the role
  matrix a way to check 98 permission gates it cannot see today. Do it first in
  this fold. It unlocks the two items below.
- **Gates derived from the route.** Once the writes are declared, `AuthOption`
  and the handler wiring in `src/routes/admin/actions.ts` can read the route
  instead of restating it. About 50 lines. Needs the item above.
- **A bind-time route check.** Make `defineAdminRoutes` refuse at bind time when
  a route has no declaration, so a new route cannot arrive undeclared. About 15
  lines added. Needs the first item above.
- **One audience predicate.** "May this viewer follow this link" is written
  three ways. Fold them into one predicate. About 8 lines.
- **Entity-page actions take a declared destination.** An `ActionDef` builds its
  own `href`, so a route whose audience is narrowed keeps a link visible to
  roles that cannot follow it. That breaks the "never render a dead or forbidden
  link" rule in `AGENTS.md`. Replace `ActionDef.href` with
  `destination: AdminDestinationId` and derive both the address and the
  visibility from the declaration. About 30 lines. This one does not need the
  98-route work.

---

## A listing price row is claimed, never checked

_Origin: the consolidation review. PR #2128 closed the rest of this entry._

`readSourceRows` in `src/shared/db/listing-prices.ts:349` ends with
`rows.rows as unknown as ListingPriceSourceRow[]`. The cast claims a shape the
code never checks, so a column renamed in the SELECT above it reaches its two
callers as `undefined` rather than failing at the read. Parse the rows instead,
the way the boundary schemas elsewhere do.

The other three parts of this entry are done. `BatchExecutor` is exported and
the ledger's `RowReader` twin is gone, and `queryAllPrimary` and
`queryOnePrimary` now give the primary read its plural, all in PR #2128. The
eleven-name co-read the entry described cannot be found in the current source,
so it went with them.

---

## Three ledger exports no rule has asked for

_Origin: the consolidation review. That review claimed that about 500 lines of
the ledger were unreachable, and it called the deletion an owner decision. Both
claims were wrong. This entry replaces them._

The ledger is not half dead. Someone wrote its unconsumed exports before the
payment aggregate, and `docs/payment-aggregate-acceptance.md` names the rule
that some of them answer. The exemption list in
`test/integration/code-quality.test.ts` now names that rule per module, or says
that no rule asks for the export. `checkout-ledger.ts`, `accounting/store.ts`
and `accounting/mappers.ts` gained production callers, so they left the list.

Eight exports have test callers alone, and they are not alike. The usage check
flags seven of them. The blind spot below hides the eighth.

- `reconcile.ts` (`reconcileExternal`, `reconcileLegs`) answer rule 2, which
  needs the refund total of the provider. `accounting/queries.ts`
  (`allTransfers`, `recentTransfers`, `accountBalance`) answer the owner review
  pages of rules 1 and 3.
- `project.ts` (`profitOfListing`, `sumOfKind`) and `reverse.ts` (`reverseOf`)
  answer no rule. Profit per listing and totals by kind appear nowhere in the
  contract. `reverseOf` builds an admin void or a correction, and the contract
  names no such action. The refunds of rule 1 use a separate model of many rows
  per original, which does not call it.

"Remove dead code" in `AGENTS.md` says to delete an export that only tests call,
and to recover it from history when a caller arrives. Against that stands a
contract that names a future caller for five of the eight. The person who owns
the payment aggregate must settle that half. The three exports that answer no
rule have no such defence, so delete them first.

Read this before you change any of it. The usage check cannot see that only
tests call `reverseOf`, because the `{@link reverseOf}` in the JSDoc of that
module reads as a production use. `isInverseOf` beside it has a live caller in
`accounting/conflicts.ts`, so the module stays exempt either way. See
"Dead-export scanner matches raw text" above.

---

## Six payment modules have no test at their mirror path

_Origin: the provider boundary work. The original entry named six modules, and
four of them (`sumup/transport.ts`, `sumup/wire.ts`,
`payment/checkout-failure.ts`, and Square's `transport.ts`) reached their mirror
with the answer-reading work. A sweep of `payment/`, `square/`, `stripe/` and
`sumup/` during the Stripe transport move found five more._

`deno task precommit:mutation` selects a source's direct tests by the mirror
path alone (`scripts/mutation/test-map.ts`). The gate refuses to run for a
source that has mutants and no test at its mirror, so a branch that changes one
of these modules cannot pass it. A source with no mutants at all is exempt,
which is why `payment/conflict.ts` and `square/api.ts` stay off this list.

| Module                                    | Mutants | Mirror path the gate looks for                  |
| ----------------------------------------- | ------: | ----------------------------------------------- |
| `src/shared/sumup/money.ts`               |      92 | `test/shared/sumup/money.test.ts`               |
| `src/shared/payment/review.ts`            |       7 | `test/shared/payment/review.test.ts`            |
| `src/shared/payment/provider-read.ts`     |       4 | `test/shared/payment/provider-read.test.ts`     |
| `src/shared/payment/refund-generation.ts` |       3 | `test/shared/payment/refund-generation.test.ts` |
| `src/shared/payment/provider-timeout.ts`  |       1 | `test/shared/payment/provider-timeout.test.ts`  |
| `src/shared/payment/refund-network.ts`    |       1 | `test/shared/payment/refund-network.test.ts`    |

The counts come from the gate's own mutant generator in its default mode. A
directory at the same path works too, so `test/shared/sumup/money/` is as good
as `money.test.ts`.

No test imports `#shared/sumup/money.ts` at all today. Its exports
(`readSumupCharge`, `sumupRefundOutcome`) are reached through
`src/shared/sumup-provider.ts`, so this is a missing direct suite rather than a
file to move. Write each missing suite, then run `deno task mutation` on the
module and close its survivors.

---

## A refund send makes one attempt, said three ways

_Origin: the Stripe transport move, which put every provider on one HTTP
boundary and left this table behind._

`REFUND_NETWORK_RETRIES` in `src/shared/payment/refund-network.ts` says how many
transport retries one refund command allows per provider. Its own comment states
the rule: durable claims, stable keys, and a fresh provider read own recovery,
so every provider makes one attempt. The table does not state it. Square and
SumUp read `SQUARE_MAX_NETWORK_RETRIES` and `SUMUP_MAX_NETWORK_RETRIES`, two
constants whose only caller is this table, and Stripe writes a literal `0`
because its transport allows two retries that a refund waives.

The two imported constants make those rows look derived. They are not: a
transport that gained a retry would let a refund spend it, against the rule
above. State the rule once for all three providers, and delete the two
constants, which then have no caller at all.

Two things to know first. `refund-network.ts` has one mutant and no test at its
mirror path, so `deno task precommit:mutation` refuses to run for a branch that
changes it — see the mirror-path entry above.
`src/features/admin/refunds/budget.ts` reads the table per provider to price the
refund subrequest budget, so keep the record shape and the per-provider read.
