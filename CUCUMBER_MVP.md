# Cucumber MVP

Status: application MVP implemented; website integration follows the website import

This MVP makes Gherkin the canonical source for user stories and observable business rules. It uses the official
Cucumber runner under the repository's pinned Deno runtime, replaces selected narrative integration tests, and
provides the structured catalog used to check promotional website content.

## Decision

Use `@cucumber/cucumber@13.2.0` through its programmatic API under Deno 2.5.6.

Do not add Node, run Cucumber through Bun, or build a custom Gherkin test runner. Pin the matching parser and
message versions used by Cucumber rather than mixing in newer syntax independently.

The canonical chain is:

```text
Feature source -> Gherkin AST -> Pickles -> Cucumber Messages -> reports and website checks
       |               |            |               |
  human story    authored schema  test cases   execution evidence
```

Stable repository IDs live in tags. Cucumber's generated AST and Pickle IDs are correlation IDs only.

## Proven feasibility

An isolated spike ran Cucumber-JS 13.2.0 inside the existing `withTestHarness` process on Deno 2.5.6. It used
TypeScript support files and the repository import map to drive the real setup wizard, login, listing creation,
attendee booking, no-quantity edit, admin roster, public ticket route, encryption, libsql database, static assets,
golden test state, and stripe-mock.

The spike established:

- Cucumber and both scenarios ran in the same process as the harness.
- `#routes`, `#shared/*`, `#test-utils/*`, and `#scripts/*` imports worked.
- Cucumber produced valid Messages NDJSON and source-located scenario failures.
- A warm real-app run took about 1.7 seconds without coverage.
- Deno coverage recorded the imported production code when the runner itself was started with `--coverage`.
- Harness cleanup removed temporary databases and test state and stopped stripe-mock.

Known limitations: Cucumber's step-definition locations point at an internal Cucumber helper under Deno, while
Feature locations and TypeScript assertion stacks are correct. Also, importing Cucumber's Node-oriented API inside
a `deno test --parallel` worker exits that worker before test registration. The coordinator process therefore runs
Cucumber after the direct Deno child exits. The paid-capacity story is the real-app compatibility gate for upgrades.

## What is schema-tized

Cucumber already supplies formal machine structures:

- `GherkinDocument` is the source AST with Features, Rules, Scenarios, Examples, steps, tables, descriptions,
  tags, comments, and one-based locations.
- Pickles are normalized executable cases. Backgrounds and inherited tags are included, and every Scenario
  Outline row becomes a separate Pickle.
- Cucumber Messages are JSON-schema-defined Envelopes encoded as NDJSON. They link source, AST, Pickles, step
  definitions, hooks, attempts, results, attachments, and run metadata.

The repository adds a narrow semantic profile over those schemas. It does not parse free prose into fields.

| Gherkin element | Repository meaning |
| --- | --- |
| Feature | One user story or capability |
| Feature description | Plain purpose and context for people and LLM checks |
| Rule | One canonical observable business rule |
| Scenario | One concrete example proving a Rule |
| Scenario Outline row | One schema-shaped case in a family |
| DataTable or DocString | Structured scenario input validated at the step boundary |
| Pickle | One executable test case |
| Messages stream | Machine catalog and execution evidence |

## Authored profile

```gherkin
@story:payments.capacity-after-payment
@owner:payments @risk:high
@actor:customer @actor:organiser
@edition:managed @edition:self-hosted
Feature: A paid booking loses the last available place
  A customer may finish payment after another customer has taken the last
  place. The customer must not be lost or charged without a clear outcome.

  @rule:payments.available-place-is-booked
  Rule: A paid customer receives a ticket while a place remains

    @case:payment.place-available
    Scenario: Payment is confirmed before the last place is taken
      Given a paid listing has one place left
      When a customer payment is confirmed
      Then the customer receives a ticket

  @rule:payments.late-customer-is-kept-and-refunded
  Rule: A paid customer who loses the place is kept and refunded once

    @case:payment.place-lost
    Scenario: Another customer takes the last place before confirmation
      Given two customers reached payment for the last place
      When their payments are confirmed in order
      Then only the first customer receives the place
      And the second customer is kept without a quantity
      And the second payment is refunded once
      And the organiser can see why the booking failed

    @case:payment.late-confirmation-repeated
    Scenario: The losing confirmation arrives again
      Given a paid booking was already kept and refunded
      When the same payment confirmation arrives again
      Then no second customer record is made
      And no second refund is sent
      And the same final result is returned
```

Required tags:

- Exactly one globally unique `@story:<id>` per Feature.
- Exactly one globally unique `@rule:<id>` per Rule.
- Exactly one globally unique `@case:<id>` per plain Scenario.
- Scenario Outlines have one `case_id` Examples column with globally unique values because individual rows cannot
  carry tags.
- Every Feature has known `@owner:`, `@risk:`, `@actor:`, and `@edition:` values.
- Optional classifications use the closed `@surface:` registry.

Feature and Rule descriptions use plain Markdown. Do not hide JSON/YAML in comments, use generated Cucumber IDs
as durable IDs, or turn tags into an unbounded database.

## Repository layout

```text
specs/
|-- owners.json
|-- payments/
|   `-- capacity-after-payment.feature
`-- <domain>/
    `-- <story>.feature
scripts/specs/
|-- catalog.ts
|-- errors.ts
|-- gherkin.ts
|-- messages.ts
|-- metadata.ts
|-- options.ts
|-- profile.ts
|-- run.ts
`-- types.ts
test/specs/
|-- support/
|   |-- hooks.ts
|   `-- world.ts
`-- steps/
    `-- payment-capacity.ts
test/scripts/specs/
|-- catalog.test.ts
|-- profile.test.ts
`-- run.test.ts
```

Generated reports are ignored:

```text
reports/cucumber.ndjson
reports/cucumber.html
reports/cucumber.junit.xml
```

The NDJSON artifact is the canonical generated catalog/result. It is never committed or edited.

## Version contract

Pin exact imports in `deno.json` and `deno.lock`:

- `@cucumber/cucumber@13.2.0`
- the Gherkin 41 and Messages 34 versions used by that Cucumber release
- matching Cucumber Expressions and tag expressions versions when imported directly

Cucumber-JS officially supports Node, not Deno. The paid-capacity Feature runs through `runCucumber` in the Deno
harness coordinator and verifies TypeScript support, aliases, hooks, the application, and Messages. Every dependency
upgrade must pass this real-app story before its lockfile change is accepted.

Do not use Gherkin 42 features while the runner uses Gherkin 41. In particular, forbid a step carrying both a
DocString and DataTable.

## Semantic profile

`scripts/specs/profile.ts` parses every Feature with the same Gherkin version as the runner and fails with
`path:line` diagnostics when:

- story, rule, case, owner, actor, risk, edition, or classification tags are missing, duplicated, or unknown
- a Scenario is outside a Rule
- a Scenario has no steps, or an Outline has no Examples
- a Feature or Rule has no useful description or executable case
- stable IDs are duplicated or malformed
- an Outline omits `case_id`, repeats a case ID, has duplicate headers, or has missing/extra cells
- a placeholder has no Examples column or a column is unused
- Examples metadata is misplaced or uses an unknown surface
- a DataTable does not match the schema declared by its step
- a DocString lacks its required media type or does not parse as that type
- a step is undefined or matches more than one definition
- a case is pending, skipped, retried, or selected by no normal profile
- a feature-local step definition is unused

Use Cucumber's dry-run/messages machinery for definition matching but derive failure locally. Dry-run exit code
alone is insufficient because Cucumber intentionally does not fail it for undefined steps.

## Step definitions

Steps describe the domain, not HTTP, form, SQL, provider, or selector mechanics.

Good:

- `Given a paid listing has one place left`
- `When the same payment confirmation arrives again`
- `Then the second payment is refunded once`
- `Then the organiser can see why the booking failed`

Wrong:

- `When I POST /payment/success?session_id=...`
- `Then listing_attendees.quantity is 0`
- `Then mockRefund.calls.length is 1`

Step implementations may make those exact assertions. The Feature states the observable contract; the TypeScript
adapter preserves mutation-resistant detail.

Prefer shared schema-backed parameter types for domain values. Validate DataTables and DocStrings with Valibot at
the boundary. Keep step modules by domain and fail on unused definitions so the vocabulary does not become a
second dead API.

## World and hooks

Each scenario gets a fresh typed `TicketsWorld`. It owns only scenario state, such as named listings, customer
records, the last response, provider spies, a `TestBrowser`, and cleanup callbacks. Do not put scenario maps in
module globals or store the global DB client in World.

Before each scenario:

1. Apply the test encryption key and required environment scope.
2. Copy either the fresh or configured golden database according to a technical tag.
3. Create scenario browser/provider adapters.
4. Initialize empty named-entity maps and cleanup callbacks.

After each scenario, even after failure:

1. Restore stubs and scoped environment in reverse order.
2. Dispose unread response bodies and browser resources.
3. Reset the database, caches, sessions, and test overrides.
4. Clear encryption state and reclaim leaked file descriptors.

Extract hook-free fixtures from helpers such as `useE2eBrowser()` and `describeWithEnv()`. Existing Deno tests and
Cucumber hooks call the same fixture mechanism until all relevant narrative tests are migrated. Do not duplicate
their lifecycle in Cucumber support code.

## Runner integration

`scripts/specs/run.ts` calls Cucumber's programmatic API. `scripts/run-specs.ts` and the main test coordinator wrap
that call in `withTestHarness`. The process CWD stays at the repository root for app/static paths. Load support code
only after the harness has built assets and started stripe-mock, because support imports production routes.

MVP settings:

- serial execution
- no retries
- strict mode
- defined source order
- progress output locally
- Messages, HTML, and JUnit files in CI
- support library reused when one process performs more than one run

Serial execution is required initially because DB selection, environment overlays, caches, and stubs are
process-global. A fresh World does not make those globals parallel-safe.

Integrate with existing commands:

| Command | Behavior |
| --- | --- |
| `deno task specs` | Run all executable Features through the shared harness |
| `deno task specs:check` | Parse and validate the authored profile and catalog |
| `deno task specs:files <paths/tags>` | Focused Feature run through the shared harness |
| `deno task test` | Run direct Deno tests and Cucumber stories under one harness lifecycle |
| `deno task test:files ...` | Dispatch `.test.ts` to Deno and `.feature` to Cucumber; mixed inputs run both |

The main harness builds assets, starts stripe-mock, and builds golden state once. It then runs grouped Deno tests
and Cucumber sequentially before one cleanup.

## Coverage

Cucumber can collect same-process Deno coverage, but acceptance stories must not be the only way a production
line or branch reaches the coverage gate. Child processes and high-level journeys are more environment-sensitive
than direct tests.

For the MVP:

1. Keep the existing 100% line/branch gate over direct Deno tests.
2. Run that gate before adding Cucumber profiles to any combined report.
3. Before deleting an integration case, move any uniquely covered production branch to its mirrored direct test.
4. Directly unit-test every branch in the Cucumber catalog, profile, selector, and report adapter. Hooks and steps
   are exercised by the real story outside the direct coverage calculation.
5. Optionally publish Cucumber coverage for diagnosis, but never use it to excuse a gap in direct tests.

## Mutation testing

Cucumber Features are integration-stage mutation targets, never replacements for mirrored direct tests.

Extend the existing mutation mechanism to:

- recognize `.feature` targets under `specs/`
- load the shared support library and selected story
- run direct source tests first and Cucumber only for surviving mutants
- launch a fresh Deno Cucumber run inside each mutation work copy
- include changed Features as changed integration evidence
- run all affected Features when shared support changes
- preserve mutant-specific golden state and static bundle rebuilding

The first story must achieve 100% targeted mutation together with the direct tests for its mapped source files.
The high-level story is not expected to kill every internal mutant alone.

## MVP story and deletions

The first vertical slice is `payments.capacity-after-payment`. It is difficult enough to prove the system rather
than just its parser: database setup, Stripe configuration, signed payment metadata, capacity loss, attendee
persistence, refund behavior, notes, terminal replay, and two request entry points.

Once the Cucumber scenarios are green, delete the equivalent cases in the same cutover:

- `test/integration/server/webhooks/single-ticket-booking.test.ts`: valid single-ticket confirmation
- `test/integration/server/webhooks/multi-ticket-booking.test.ts`: sold-out confirmation and refund
- `test/integration/server/payments/replay.test.ts`: sold-out confirmation replay

Only those cases are removed, not the whole files. Any token persistence, encryption, protocol, or branch detail
not expressed by the story must already exist in a mirrored direct test or move there before deletion.

Lower-level tests remain for atomic capacity, transaction rollback, refund decisions, processed-payment locking,
provider signatures, concurrency, package/modifier variants, malformed inputs, and provider failures. They prove
mechanisms and edge conditions rather than duplicating the user story.

The old and new scenarios may run together temporarily during development, but no PR merges with both paths.

## Website integration

After the site moves under `website/`, pages declare the stories or rules they discuss in front matter:

```yaml
stories:
  - payments.capacity-after-payment
```

Use block-level rule IDs only when one page contains unrelated claims. Extend the website's page/block schema so
the IDs are validated and available to tooling but are not rendered as test metadata.

The semantic content checker receives:

- the selected Feature name and description
- its Rules and Scenarios, including qualifications and scope tags
- the selected website text

It returns `supported`, `not_present`, `contradicted`, `overstated`, or `wrong_scope` per Rule and reports
unsupported objective claims. Keep the existing strict LLM requirements: pinned model/prompt, Valibot output,
verbatim quotes, local verdict, bounded inputs, content-addressed cache, no retry of semantic failures, fork-safe
secrets, and inspectable artifacts.

Cucumber replaces the proposed behavior-fact JSON, fact-to-test LLM checker, behavior usage sidecars, and custom
execution catalog. Passing Pickles, direct coverage, and mutation results are stronger test evidence than an LLM
reading test source.

Static commercial, legal, organization, and competitor reference claims are outside this MVP. Do not invent fake
Given/When/Then scenarios for them. Add a small typed reference variant later only when a real claim cannot be
represented as an observable Rule.

## CI selection

Use one `base...HEAD` changed-set utility.

| Changed input | Work |
| --- | --- |
| `.feature` | Profile, affected scenarios, website semantics, targeted mutation when high-risk |
| Step/support code | Affected or all scenarios plus targeted mutation |
| Cucumber runner/profile/schema | Direct tooling tests and every scenario |
| App source | Existing app gate plus all stories in MVP; add domain selection only when needed |
| Registered website text | Website build plus affected semantic checks; no full app suite |
| Story metadata only | Profile and affected semantic checks |
| LLM prompt/model/schema | Full registered semantic audit |
| Scheduled/manual audit | Full profile, stories, report generation, and website semantics |

Spec-only changes do not build or deploy the website. Website-only changes do not run the full app suite. The
always-present required `test` result remains as specified in `SITES_PLAN.md`.

## Delivery steps

1. Pin Cucumber and add the real-app Deno compatibility test.
2. Add profile/catalog validation and direct tests with no product Feature yet.
3. Add typed World, hooks, runner, Messages/HTML/JUnit output, and focused-run support.
4. Reuse the existing harness and extract hook-free DB/browser fixtures.
5. Add the three-scenario paid-capacity Feature and payment step module.
6. Run old and new scenarios temporarily to compare observable and stored outcomes.
7. Move any lost direct coverage assertions, then delete the three old integration cases.
8. Extend mutation selection/execution and achieve a 100% targeted score.
9. After the website import, add its story mapping and run the semantic check in advisory mode.
10. Measure runtime, lines removed/added, report usefulness, and maintenance before the next migration.

## MVP acceptance

- Official Cucumber 13.2 runs programmatically under pinned Deno 2.5.6 without Node or Bun.
- The real paid-capacity story covers TypeScript support, aliases, hooks, Messages, and the complete app path.
- Two catalogs from the same checkout are byte-identical after volatile run metadata is excluded.
- Every Feature, Rule, Scenario, and Outline row has a valid stable ID and schema-valid metadata.
- Every step matches exactly one definition; undefined, ambiguous, pending, retried, and dead steps fail.
- Cucumber runs inside the existing harness and leaves no DB, asset, stripe-mock, environment, or cache leak.
- The three selected integration cases are deleted with no equivalent wrappers left behind.
- Direct Deno tests still independently achieve 100% line and branch coverage.
- Targeted mutation over the changed payment source has a 100% score.
- Focused `.feature` runs, full precommit, JUnit, HTML, and Messages artifacts work.
- The story catalog is ready for the website mapping added after the website import.
- No parallel behavior facts JSON, behavior usage sidecars, custom runner, or fact-to-test LLM system is added.

## Expansion rule

Migrate the next narrative test only when it deletes at least as much special-purpose orchestration as it adds and
reuses the established vocabulary. Strong next candidates are no-quantity ticket behavior, ticket editing,
servicing journeys, booking narratives, accounting lifecycles, and the live provider sandbox orchestration.

Do not migrate pure functions, property tests, schemas, SQL/transaction contracts, migrations, query budgets,
protocol serialization, or test-infrastructure internals. Their direct TypeScript tests are already the smaller,
stronger specification.
