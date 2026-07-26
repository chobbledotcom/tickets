# End-to-end and acceptance tests

How this repository writes Cucumber acceptance specifications and the direct
tests that live alongside them. [AGENTS.md](AGENTS.md) covers everything else;
this file is the detail for anyone writing, migrating, or reviewing a story.

Read [Migrating a test to a story](#migrating-a-test-to-a-story) before turning
an existing test into a Feature — the checklist there exists because the same
mistakes have been made repeatedly.

## What Cucumber owns, and what it does not

Cucumber owns user journeys and observable business rules. Direct Deno tests
still own pure logic, properties, schemas, SQL and transaction contracts,
migrations, protocol details, query budgets, concurrency, and test
infrastructure. Never translate a direct technical test into Gherkin when the
TypeScript test is smaller or more exact.

## Test architecture — three categories, no generic e2e bucket

Every test falls into exactly one of three categories. A generic `test/e2e`
bucket is not one of them — each existing e2e test should eventually become
either a Cucumber story or a narrowly scoped direct technical contract test.

1. **Pure unit/property tests** — data in, data out. No database, network,
   filesystem, DOM, subprocess, or real clock. Mirror the source file.
2. **Direct technical contract tests** — exercise the smallest real boundary
   necessary: SQLite, Request/Response, provider transport, DOM, WebCrypto,
   build artifact, module graph, filesystem, subprocess, or concurrency. These
   own SQL constraints, migrations, triggers, transactions, wire protocols,
   HTTP security, cryptographic interoperability, query/resource budgets, and
   tooling contracts. They cannot be replaced by Cucumber or pure tests.
3. **Cucumber acceptance specifications** — one user story or observable
   business rule per Feature, in domain language only. No SQL, route names,
   field names, selectors, mocks, or provider payloads.

**Migrate e2e tests toward Cucumber or direct contracts.** When touching an
e2e test, ask: can the claim be stated as an actor-facing rule without
technical nouns? If yes, move the narrative to Cucumber and delete the old
test. Is the production behavior fully determined by explicit values? If yes,
keep or extract a pure function and test it directly. Would replacing the real
boundary make the assertion stop proving its subject? If yes, keep a direct
technical contract test. Split tests that mix all three concerns by claim
rather than duplicating.

**New features need Cucumber coverage when applicable.** A new feature that
introduces an observable user journey or business rule ships with a Cucumber
Feature alongside its direct tests. A feature that is purely technical (a
migration, a protocol change, a performance fix, a refactor) does not need
one. The Cucumber Feature must not be the only coverage of a production line
or branch — keep 100% direct Deno coverage.

The authored hierarchy is strict:

- A `Feature` is one user story or capability and has exactly one globally
  unique `@story:<id>` tag.
- A `Rule` is one canonical observable product rule and has exactly one
  globally unique `@rule:<id>` tag. Every Scenario belongs to a Rule.
- A plain `Scenario` is one concrete example and has exactly one globally
  unique `@case:<id>` tag.
- A `Scenario Outline` is one coherent family of examples. Its Examples table
  has a unique `case_id` column because individual rows cannot carry tags.
- Every Feature has one known `@owner:`, `@risk:`, at least one `@actor:`, and
  at least one `@edition:` tag. Other tag kinds come from the checked registry;
  ad-hoc metadata tags are forbidden.
- Feature and Rule descriptions explain their purpose in plain language. Do
  not hide JSON, YAML, evidence paths, or another schema in comments.

Write the smallest scenario that proves the rule:

- Use 3-5 Given/When/Then steps and one action per Scenario where possible.
- Describe the domain and observable result, not routes, SQL, selectors, form
  field names, provider payloads, mocks, or implementation details.
- Keep exact mutation-resistant assertions in the TypeScript step definition.
  A plain-language `Then the payment is refunded once` may assert the exact
  provider call count, stored note, terminal result, and lack of a duplicate.
- Use `Scenario Outline` only for the same rule over a real input family, never
  to combine unrelated facts or reduce line count.
- Validate DataTable rows, DocStrings, custom parameters, and Examples cells at
  the boundary with a typed schema. All table cells begin as strings; never
  cast and hope.
- Business setup belongs in Given steps. Hooks contain only technical fixture
  setup and cleanup that a reader does not need to understand the rule.
- Every step must match exactly one definition. Undefined, ambiguous, pending,
  skipped, and retried steps fail. The full suite also fails on unused step
  definitions; focused runs may leave unrelated shared definitions unused.
- **Drive through the real rendered form.** A Cucumber `When`/`Then` that
  submits an admin edit must read the production HTML form, parse its fields
  and CSRF token, and POST exactly what a browser would. Do not reconstruct
  the form state from database rows — that bypasses the rendering layer the
  scenario exists to prove and would silently keep passing if the editor
  stopped rendering a field or emitted one the POST parser cannot consume.
  Exception: pure data-in/data-out rules with no user-facing form action may
  read state directly. When a form is involved, use
  `extractFormEntries`/`extractCsrfToken` against the real served page.

Execution is equally strict:

- Run the pinned official Cucumber API under the repository's pinned Deno, in
  the existing test harness. Do not add Node, run Cucumber through Bun, or make
  another Gherkin runner.
- Use a fresh typed World for every Scenario. Never keep scenario entities in
  module globals or hide the global database client in World.
- Run Scenarios through the bounded Cucumber worker pool. Each worker has its
  own isolate, and every Scenario gets a fresh database and World. Test
  environment changes must use `withEnv` so `Deno.env` and the worker's
  `process.env` stay aligned. Do not add retries; a pass after retry is still a
  flaky failure.
- Reuse the existing golden database, stripe-mock, static assets, encryption,
  browser, cache reset, and cleanup mechanisms. Extract one hook-free fixture
  when Cucumber and Deno hooks need the same lifecycle; never maintain two.
- Cucumber Messages NDJSON is the generated machine result. HTML and JUnit are
  reports. Generated AST, Pickle, Messages, and report files are never sources
  of truth and are not committed.
- Stable repository IDs come only from authored tags. Cucumber AST/Pickle IDs,
  names, paths, and line numbers are not durable IDs.
- Screenshot evidence uses those authored story, rule, and case IDs plus a
  separate stable capture ID. Its public contract is
  `reports/evidence/manifest.json` with files under `reports/evidence/assets/`;
  raw Cucumber Messages stay generated and private.
- A Cucumber journey never supplies the only coverage of a production line or
  branch. Keep 100% direct Deno coverage, and run direct tests before Cucumber
  integration tests in mutation runs.
- A migration is a replacement: delete the old narrative test in the same
  change. Temporary old/new comparison is allowed while developing, but no PR
  merges with two paths for one behavior.
- New shared steps must be reused by the current story or an immediately
  included second story. Do not create a speculative vocabulary.


## Running the specs

- `deno task specs` — every Feature through the shared harness
- `deno task specs:files <feature>... [--tags <expression>]` — selected Features
- `deno task specs:check` — parse every Feature and validate the authored
  profile and the stable catalog
- `deno task specs:evidence` — the cases with declared screenshot captures

The full list, with what each writes where, is in
[AGENTS.md](AGENTS.md#scripts).

## Migrating a test to a story

A migration is a **replacement**, and the risk is always the same: the story
reads better than the test it replaced while quietly proving less. This has
happened repeatedly, so it is a required step, not advice.

**Before you delete the old test, list every claim it made, and tick each one
off against the new story.** Write the list somewhere you can check — the pull
request description is a good place, because a reviewer can then check it too.
A claim is anything the old test asserted: a status code, a count, a rendered
figure, a stored row, a ledger balance, a log entry, an absence.

Each claim ends up in exactly one of three places, and you should be able to say
which:

1. **In the story**, as a plain-language `Then` with the exact assertion behind
   it in the step. Most claims land here.
2. **In a direct test you keep or write**, when the claim is technical — a
   status code, a stored shape, a query budget, a branch a story may never be
   the only cover of.
3. **Deliberately dropped**, because the claim was about the old test's own
   scaffolding rather than the product. Say so out loud; do not let it vanish
   silently.

Claims that have gone missing in real migrations here, to show the shape of the
problem:

- the double-entry conservation check (`sumOfAllBalances()`) after each money
  action,
- the premise itself — that three £50 sales counted £150 *before* the refund
  ran, without which the closing figure proves nothing,
- that the customer actually got their money back, as opposed to the charge
  merely being undone in the books,
- the ordinary "duration changed" history entry, when only the exceptional
  overflow warning was carried across,
- that a booking still exists, as opposed to merely having no refund against it.

Then finish the job:

- Delete the old test in the same change. Two paths for one behaviour must not
  merge.
- Run the whole gate **after** the last edit, including `deno task
  test:coverage`. Deleting a test often orphans a helper (see
  [Coverage traps](#coverage-traps-when-deleting-tests)).
- Add the story's id to the catalog test and check `deno task specs:check`.

## Pitfalls that keep coming up

These are all real review findings from the migration batches. Each one passed
its scenario at the time.

### Driving the page, not just posting to it

A story that submits a form must send what a visitor could actually send. The
test browser will post anything you hand it, so "it passed" says nothing on its
own. Before submitting, check that:

- every field you are about to send is **rendered on the page**;
- any value chosen from a dropdown is **one of the options offered**;
- the control is **usable** — not `disabled`, and not a hidden input fixed at a
  different value.

`test/specs/support/form-controls.ts` does all of this; use it rather than
writing a new check. Two traps it exists because of: matching `<select
name="…">` misses markup that writes `id` first, and looking for `disabled`
anywhere inside a `<select>` wrongly rejects a perfectly normal disabled
placeholder option.

Do not reconstruct form state from database rows. That bypasses the rendering
layer the scenario exists to prove.

### Refusals must prove why they were refused

"No thank-you page" is not "the listing was full". A validation error, a
missing form, a 500, or a redirect to login all produce the same absence. Assert
the **specific reason** the site gives — ideally by importing the production
message builder rather than copying its wording. The same applies to an admin
action: assert the flash the operator is shown, not merely that a redirect
happened.

### The clock and the calendar

A scenario that computes days from "today" on each call can straddle midnight and
set up against one day while asserting against the next. Fix the scenario's first
day **once** per World and derive every other day from it.

### Don't trust a position in a list

`getAttendeesRaw` returns rows newest-first. Taking "the newest" with `.at(-1)`
quietly picked the *oldest* booking and passed for weeks, because the scenario
that read it happened to have one booking at that point. Identify a row by
something meaningful — the highest id, a name, a token — not by where it sits.

### Fixtures fail loudly

A `!` on a missing fixture entry surfaces as `undefined` somewhere unrelated,
usually inside a later query. Check what you were given and throw with context:
`Expected three people to have paid, found 2`.

A default that happens to equal the value the scenario asserts is worse than no
default: the setup can stop reading the feature's own number and the story stays
green. Use `requiredWorldValue`.

### Coverage traps when deleting tests

Coverage measures everything the direct suite loads, and Cucumber runs do **not**
count towards it. Two consequences bite regularly:

- **Deleting a test can orphan a helper.** If the only remaining caller of a
  shared test-util is a story, its lines are now uncovered. Either move the
  helper to the story's own support directory (where it is not measured), or
  keep a direct test for it. Prefer moving it — it belongs with its only user.
- **Adding a direct test to a story-support module pulls that whole module into
  the gate**, so everything in it that only stories reach turns red. Keep pure,
  directly-testable rules in their own module and leave the browser-driving
  shell with the stories.

And the rule that catches both: a story may never be the only cover of a
production line or branch.

### Say what the product actually does

Plain language must still be true. "The organiser hands the money back"
described a choice that returns nothing to the customer's card — it records
credit owed to them. A reader would have learned the opposite of the truth. When
naming a money decision, a status, or an outcome, check what the code does
before you name it.
