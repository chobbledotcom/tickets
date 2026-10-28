# Duplication limits for the test helpers: what each step down costs

This document records the duplication limits for the test helper trees, the
reason each limit holds, and the cost of the remaining steps.

**Decided and shipped.** The reusable helpers under `test/test-utils` are
scanned at **40 tokens**, alongside `src/`, by `.jscpd.helpers.json`. The
Cucumber support helpers under `test/specs/support` are scanned twice: at **18
tokens** alongside `src/`, and at **15 tokens** on their own by
`.jscpd.support.json`. The 18-token scan holds its accepted clones in the
committed baseline `.jscpd.specs-baseline.json`, the way the renamed-clone gate
does. See [What is left](#what-is-left) for the remaining steps.

All counts come from commit `ebc7c12` and from jscpd 5.0.12 with `minLines: 1`,
the setting every config in this repository uses. A count is the number of clone
pairs the scan reports, not the number of places to edit: one merge usually
clears several pairs.

## The six scans, and why there are six

The 0% threshold is not the number that decides how hard jscpd looks.
`minTokens` is. It sets the shortest run of tokens that counts as a clone, so a
lower number is a tighter net.

| Config                | Scans                            | minTokens |
| --------------------- | -------------------------------- | --------- |
| `.jscpd.json`         | `src`, `e2e-payments`, `scripts` | 19        |
| `.jscpd.specs.json`   | `src` + `test/specs/support`     | 18        |
| `.jscpd.support.json` | `test/specs/support`             | 15        |
| `.jscpd.helpers.json` | `src` + `test/test-utils`        | 40        |
| `.jscpd.test.json`    | `test`                           | 48        |
| `.jscpd.css.json`     | `src/ui/static/style.scss`       | 50        |

The last one holds no tests, so the rest of this document leaves it out. Its
number is high because design-token CSS repeats short declaration runs by
design, and those runs are not duplication.

The code scans ignore two kinds of file that this document does not cover
elsewhere. `fp.ts` holds curried adapters, and those match each other by design.
The migration files are append-only history: each one repeats the same
`schemaMigration(...)` call scaffold, and a shipped migration must never change.
Each migration body is unique, so the scaffold is the factory, not a missed
merge.

Two trees hold reusable helpers. `test/specs/support` holds 76 files and 11,673
lines behind the Cucumber steps. `test/test-utils` holds 160 helper files and
19,164 lines, plus 32 files of tests for those helpers. Both are
production-shaped code: one named helper for each thing a person, or a test,
does. Two helpers that nearly match are a merge to make.

A test body is different. It repeats by design, and the shared mechanism is the
test framework itself. That is why the whole of `test/` sits at 48 tokens, and
why the helper trees can be held tighter than the tree that contains them.

## The support helpers hold at 15 tokens

The shared scan `.jscpd.specs.json` reads `src/` alongside the support helpers,
so a helper that reimplements production logic is flagged against the source it
copied. `src/` is clean at 19 and cannot go below it:

| minTokens | Clone pairs in `src/` alone |
| --------- | --------------------------- |
| 19        | 0                           |
| 17        | 497                         |
| 16        | 961                         |

So a 0% threshold cannot hold _that_ config below 19. The support helpers
therefore get a second scan of their own, `.jscpd.support.json`, which drops
`src/` and holds them at 15. **18 is where the shared config sits, not where
the helpers have to stay.**

### The 18-token shared scan carries a baseline

Below 19 tokens the shared scan reads real signal and coincidence together.
Dropping `.jscpd.specs.json` to 18 tokens surfaces 220 clone pairs. Most are
the coincidence classes this document already names: import blocks, matching
signatures and parameter lists, type aliases, schema table data, and support
test bodies. The scan cannot hold those at zero without a full-band
classification, so the config carries a committed baseline instead. `deno task
cpd` runs the specs config with `--baseline .jscpd.specs-baseline.json
--fail-on-new-clones`, exactly the way the renamed-clone gate does.
`deno task cpd:specs --update` rewrites the baseline after a merge. A new
18-token clone anywhere in the scanned trees fails the gate.

The first pass merged the pairs that were real duplicated logic:

- `order-gallery.tsx` routes both the listing card and the package card
  through one `renderSelectableCard` helper. They differed only in the option
  key, the form-field prefix, and the text.
- `api-site-pages-input.ts` names the shared "longer than the field's cap"
  refusal `tooLong`, and the slug, the page name, and the text fields all
  route through it.
- `validated-session.ts` names the repeated
  `Pick<ValidatedPaymentSession, "id" | "paymentReference" | "provider">`
  parameter slice `SessionPaymentReference`, so the two charge-reference
  readers no longer repeat the type.

The remaining 217 pairs sit in the baseline. They are import-block and
signature matches, one-line field and schema builders, and the support test
bodies. Each is a separate merge when its band is classified.

Read a whole band before you lower a limit. A small sample can call a band
noise while the full band marks an under-adopted curry. At 16 tokens, a sample
of eight pairs read the band as noise. A classification of all 78 pairs found
46 merges behind a curry that `browser.ts` already holds. The other 32 pairs
were 5 pairs that share only an assertion helper and 27 pairs that match on the
signature and the types alone.

### The named step types in `world.ts`

Two unrelated bodies behind the same `(world: TicketsWorld, name: string)`
parameter list are the honest exception. The repetition is the parameter list
itself, and a named type removes it. `ActOnOneThing`, `ReadAboutOneThing`,
`AsksAboutOneThing`, and `ActOnTheStory` in `world.ts` name the common
parameter lists. `ActsOnPersonsBooking` and the `StoryJourney`-derived shapes
cover the booking and messaging signatures.

### The one helper for each repeated thing

- `opensAdminPageAt` and `withAdminPage` in `browser.ts` are the curries for
  the admin-page opens. `withAdminPage` carries a result back.
- `createAttendeeOn` in `test/test-utils/db-helpers/attendees.ts` is the one
  `createTestAttendee` call on a listing. The note, deposit, and editor
  journeys route through it.
- `askListingsApi` in `booking-api.ts` is the one "read an API listing
  endpoint, expect a 200" open.
- `sendWithTheCode` in `discount-codes.ts` is the one promo-code send.
- `requireGroup` in `browser.ts` is the one "hand back the matched group or
  fail loudly" guard.
- `regionOutOf` in `browser.ts` is the one region-slice. `articleOutOf`,
  `footerHtml`, and `proseHtml` all route through it.
- `outgoingWatch` in `outgoing.ts` is the one "the watch a story put in
  place" accessor.
- `emailFor` is the one address rule, and `ownerWrites` is the one email
  wording helper. The bulk-email stories use both.
- `theBooking` and `theListing` in `world.ts` are the one booking and listing
  accessors.
- The two steps that take a thing off sale are one step. Both stories use the
  site's confirmed deactivate form, the way the catalogue step always did.

Two helpers keep their own shape, and say why in a comment. `deposits.ts` joins
a person's names with a hyphen, so its address is a different address, not the
same one written twice. `asksNotToHearAboutPromotions` has to serve the choices
page before it can name the button on it, because serving the page is what loads
that group of copy.

## The other helper tree holds at 40 tokens

`.jscpd.helpers.json` reads `test/test-utils` against `src/` at 40 tokens. The
golden test database is built by `fullSchemaCreateStatements()` from
`src/shared/db/migrations/schema-sync.ts`, the one production schema builder. A
helper that reaches the app goes through `awaitTestRequest` or `testPageHtml`
in `test/test-utils/mocks.ts`.

## What is left

These counts are for the helper files and `src/` at the commit above:

| minTokens | Clone pairs | Note                                       |
| --------- | ----------- | ------------------------------------------ |
| 40        | 0           | where the scan is set                      |
| 36        | 17          | strong signal, mostly whole shared helpers |
| 32        | 31          |                                            |
| 28        | 67          |                                            |
| 24        | 113         |                                            |
| 19        | 280         | parity with the Cucumber helpers           |

**These are counts, not verdicts.** A sample of the 24-token band showed valibot
schema fields that match across unrelated schemas, which is the same coincidence
that exempts `src/shared/db/migrations/schema/columns.ts` from `.jscpd.json`,
and one-line field builders that match on a signature. A sample is not a
decision. Classify a whole band, and try the curry, before you call any of it
unavoidable.

Each step down is a separate job. Take the number in `.jscpd.helpers.json` down,
bring the tree to it, and repeat, the way the comment caps in
`scripts/check-comments/run.ts` come down.

## The renamed-clone gate: same code with different words

jscpd matches literal token runs, so a rename hides a copy: every renamed word
breaks the run, and two spellings of one operation sit below `minTokens` 19. The
worked example was the slug-index family — `computeGroupSlugIndex`,
`computeNewsSlugIndex`, `computeSitePageSlugIndex`, and `computeSlugIndex` were
four spellings of `(slug) => hmacHash(slug)`, each one identifier short of
detection. All four were deleted and every caller now uses `hmacHash` directly.

Since jscpd 5.2.0 the gate is jscpd's own. `deno task cpd:renamed` runs
`.jscpd.renamed.json`, which passes `--similarity 0.99`: whole functions,
methods and arrow functions are compared by AST shape, with names and literals
left out, so a renamed copy scores 1.0 and is reported with kind `similar`. The
accepted matches live in the committed baseline
`.jscpd.renamed-baseline.json`. The flag `--fail-on-new-clones` fails the build
on a pair the baseline does not carry, and `deno task cpd:renamed --update`
rewrites the baseline after a merge. The baseline records no written reason —
the merge history carries it.

Since jscpd 5.4.2 the strict scans (`.jscpd.json`, `.jscpd.test.json`,
`.jscpd.helpers.json`, `.jscpd.support.json`) enable the Type-2 clone options
`ignoreIdentifiers`, `ignoreLiterals` and `ignoreAnnotations`, and each reports
only kind `exact`. jscpd classifies each matched window. A window whose raw
tokens differ only in names, literal values or annotations is a `renamed`
clone. A window with identical raw tokens is an `exact` clone. jscpd splits a
longer match at the tokens that differ. A renamed copy can still leave a
raw-identical stretch. When that stretch reaches the scan's `minTokens`, the
strict gate reports it and demands the merge. The `kind` filter removes the
renamed windows, so the gates still count only token-identical code. The
renamed-clone gate still tracks renamed functions in the trees it scans. A run
that asks for every kind, or a report without the `kind` filter, shows the
renamed clones too.

A pair changes status one way: merge it (extract a helper, or curry the parts
that differ), then refresh the baseline. A new renamed copy anywhere in the
scanned trees fails the gate, which is the point: the slug-index class of drift
cannot regrow silently.

**The baseline shrinks as merges land** — merge a family, run
`deno task cpd:renamed --update`, and its fingerprints drop out. The larger
families at the time of writing are the field-picking map pairs across the admin
pages and the table `getXById` wrappers, which are the coincidence class:
enough code builds an object from another object's fields for unrelated
functions to match, and the baseline absorbs them while the real merges
proceed.

## What was measured and rejected

**A tighter scan for the whole of `test/`.** The tree is clean at 48 tokens and
very expensive below it:

| minTokens | Clone pairs in `test/` |
| --------- | ---------------------- |
| 48        | 0                      |
| 44        | 291                    |
| 40        | 873                    |
| 36        | 1,749                  |
| 32        | 3,385                  |

The rise is test bodies, not helpers, so a lower number here buys little and
costs a great deal. 48 stays.

**A carve-out for `test/test-utils` in `.jscpd.test.json`.** The specs config
takes `test/specs/support` out of the ordinary `test/` scan. That hides any
clone between a support helper and a test body, and today the count of those is
zero, so nothing is lost. `test/test-utils` is not carved out: it stays in both
scans, so its clones against test bodies are still caught at 48. The second scan
of 19,000 lines costs about one second.
