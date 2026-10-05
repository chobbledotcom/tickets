# tickets

A minimal ticket reservation system using Bunny Edge Scripting and libsql.

## Where to find guidance

All repository guidance is in this file or in documents that it links to. Read
this file and follow its links. Do not search the wider machine for
instructions, plans, or approval records. If required guidance is absent, ask
the user for its location.

## Getting Started

Development machines run NixOS. The developer environment is devenv
(`devenv.nix`), and it provides the pinned Deno and the other tools. Install
devenv once (`nix profile add nixpkgs#devenv`), then enter the shell:

```bash
devenv shell
```

For one command, run it through the shell. Put `--` before a command that
carries its own flags:

```bash
devenv shell deno task precommit
devenv shell -- deno task test --filter "formats date"
```

To start the shell on every entry to this directory, add the hook to your shell
(`eval "$(devenv hook bash)"`, or the zsh and fish equivalents), then run
`devenv allow` once. Do not add a direnv `.envrc`.

All `deno ...` commands in this file assume you are already inside
`devenv shell`. Non-interactive agents must prefix them with `devenv shell`.

## Runtime Environment

- **Production**: Bunny Edge Scripting (Deno-based runtime on Bunny CDN)
- **Development and testing**: Deno
- **Build**: `esbuild` with `platform: "browser"` bundles to a single
  edge-compatible file

Code must work in both environments.

## Deno Version

This repo pins Deno 2.5.6, the lowest Bunny Edge Scripting runtime version this
project runs on. `enterShell` in `devenv.nix` refuses to enter when the pinned
nixpkgs provides anything else:

```bash
devenv shell -- deno --version
```

`nixpkgs` and `nixpkgs-deno` are pinned to commits in `devenv.yaml`. Edit the
SHA there, then run `devenv update`. CI uses the same environment through
`.github/actions/setup-devenv`. CI jobs that never launch a browser evaluate it
with `devenv --profile ci shell`.

## stripe-mock

The test harness needs the `stripe-mock` binary at `.bin/stripe-mock`. The
standard runners (`deno task test`, `deno task test:files`, and `--harness`
mutation runs) start one on a free local port, so parallel suites do not fight
over port 12111. The harness downloads a prebuilt release from GitHub. Where
that download is blocked, build it from source with Go:

```bash
GOBIN="$PWD/.bin" go install github.com/stripe/stripe-mock@v0.188.0
```

Pin the version the harness expects (`STRIPE_MOCK_VERSION` in
`scripts/stripe-mock/install.ts`). Once `.bin/stripe-mock` exists, the harness
uses it as-is.

## Preferences

These preferences are defaults, not laws. When the letter of a rule and its
purpose pull apart, serve the purpose. Say which rule you bent and why.

- **Plan behavior before code**: Follow [PR_WORKFLOW.md](PR_WORKFLOW.md) for
  every non-trivial change. Fill in the behavior contract, challenge it, and get
  human approval before implementation.
- **Once it is built, the code is the authority**: A behavior contract governs
  work that does not exist yet. When a slice lands, its code and tests are the
  truth. Check every finding or amendment against the real `src/` and `test/`
  before you touch the plan. When the built behavior is wrong, fix the code and
  pin it with a regression test. Amend the contract only when the contract is
  what is wrong, and change the document and the code in the same commit.
- **Write technical text in Simplified Technical English**: Documentation,
  commit messages, pull request descriptions, and developer-facing error
  messages follow
  [Simplified Technical English](#simplified-technical-english--how-we-write-documentation).
  Copy inside the app follows
  [Simple Language](#simple-language--how-we-talk-to-users).
- **Use FP methods**: Prefer curried functional utilities from `#fp` over
  imperative loops (see [FP Imports](#fp-imports)).
- **Plain language for functional code**: Keep the functional style, but name
  helpers and write comments in simple domain words, not CS jargon. A helper
  must explain itself like "Keeps only children that can still be booked for
  this ticket."
- **Name a thing the way the site names it**: A story, test, or comment calls a
  thing what its label, message, or column heading calls it. Copy the word a
  person reads in `src/locales/en/*.json`, never the identifier beside it in
  `src/`. Keep one word for one thing inside a single document. A `@story:`,
  `@rule:`, or `@case:` id is a durable identifier and never moves.
- **Comments describe current code**: Delete comments that compare current code
  with an old implementation. Git history keeps the old code.
- **Comments are short**: A comment only adds what the reader cannot see — a
  why, a constraint, a surprise. Never re-narrate the lines below in prose, and
  never restate a name. If a comment grows, fix the tangle it explains. The same
  bar applies to commit messages and PR prose.
- **Zero code duplication**: See [Code Duplication](#code-duplication).
- **100% test coverage**: Coverage must be complete and deterministic. A branch
  that only a spawned subprocess reaches gets a direct in-process unit test.
- **Hardest first, no need to ask**: When the only open question is the order to
  build several things in, build the more difficult one first.
- **Always the complete version**: Choose the complete, correct version, even
  when it touches more files than the estimate named.
- **Feature-complete by default**: Build the whole feature. Stop short only when
  finishing it adds more branches or more special cases than the honest shape
  needs.
- **Unify systems — the answer is yes**: When two systems do almost the same
  job, find the single abstraction that does both.
- **No alias exports**: Never export a name that only renames an imported
  method. Expose the underlying helper and let callers use it. A thin wrapper
  that adds a default, a transformation, or a guard is fine.
- **No internal compatibility layers**: When you replace an internal API,
  migrate every caller in the same change and delete the old surface. Keep
  adapters only at true external boundaries.
- **Imports name a module one way**: Add an import alias only when it removes 50
  or more wrapped import lines. Below that bar, keep the module under
  `#shared/`.
- **Remove dead code — always the answer**: When code has no production caller,
  delete it. Never keep it "for symmetry" or "for future use", and never paper
  over it with a test-only import or a usage-check exemption. An export that
  only tests use is dead.
- **Never loosen a check to close a finding**: Fix the code, or argue on the
  thread that the finding is wrong. A deliberate change to a check is an owner
  decision, never a side effect of review pressure.
- **Keep code and test files under ~400 lines**: The aim is 400 lines. The
  enforced limit is 500. Biome holds a hard 1,000-line ceiling. When your own
  change adds hundreds of lines, put them in a new file from the start. When a
  small edit pushes a file slightly over the aim, open an issue that owns the
  split, or update the one that exists, and leave the file alone.
  `deno task check:file-lengths` enforces the limit against the accepted list at
  `scripts/check-file-lengths/over-limit.json`, which only shrinks. When you
  split, give the new files shorter names that do not repeat the folder's name,
  and separate pure data-in/data-out logic from the IO shell.
- **Good citizen — fix what you spot**: Fix a bug, a coverage gap, or a flaky
  test you notice, even in code you were not asked to touch.
- **A written-down diagnosis is a hypothesis, not a finding**: Re-derive every
  written diagnosis from the current source before you fix anything.
- **A finished job closes its issue**: Close an issue in the same change that
  finishes it. Never leave one open and marked "done". When you find an issue
  the code already answers, close it with a comment that names the answer.
- **Stage what you changed, never `git add -A`**: Name the files you meant to
  touch, and read `git status --short` before you commit.
- **Judge nothing from a stale base ref**: Run `git fetch origin main` before
  you read an `origin/main...HEAD` diff or run the mutation gate.
- **A red check is not automatically yours**: Trace a CI failure far enough to
  name the cause before you set it aside. Say so once, with evidence, then
  re-run. Never ignore a failure.
- **Every bug fix ships with a regression test**: Write the failing test first,
  confirm it fails for the right reason, then fix and watch it go green. The
  test must reproduce the real bug.
- **A branch fixes the defects it introduces**: A review finding about code the
  branch adds is that branch's work. Fix it and pin it there. An issue is for a
  defect that is already on main.
- **Attribute money to its true item at write time**: A money movement lands
  against its true money item on the day it happens. Treat "we can fix the
  records up later" as a design smell.
- **Trust application invariants**: Do not design normal paths around database
  states the application says are impossible. If an impossible state is
  observed, raise it and repair the data explicitly.
- **Do not defend against the impossible**: No fallbacks or catches for failures
  that need the whole app to be down. Let them throw. Reserve resilience for
  failures that occur in normal operation.
- **A loud database failure is enough**: Database writes fail very infrequently.
  Let the error reach the log in full, and let the admin investigate. Do not
  build rescue, repair, or compensation paths around a failed write.
- **Trust request key setup**: Startup validates `DB_ENCRYPTION_KEY`. On every
  route other than setup, the setup step has already created the owner and the
  public key. Do not check either key in request code, and do not test states
  that only corrupt setup can make.
- **New tables and new columns are a last resort**: Make the fact fit the schema
  you have. A review that asks for one must name the fact and say why no current
  column can hold it.
- **New environment keys and secrets are a last resort**: Each new key must be
  set by hand on every site in the Bunny dashboard. Prefer a value you can
  derive, or a setting the site already stores.
- **One path for one-or-many**: Do not write a "single" path beside a "multiple"
  one. Model the operation over a collection once, and call it with an array of
  one. A thin singular wrapper that delegates is fine.
- **Schema over organic structure**: Model content as data (a typed list of
  sections, entries, or fields) and render it with one shared function — even
  for help pages, navigation, and form layouts.
- **Shared interfaces over branch-per-case**: Model cases as a typed union plus
  an exhaustive `Record` keyed by it, or as per-entry rules folded over
  uniformly. A forgotten case must be a compile error, not a silent default.
- **Malleable software**: Where it is safe, expose stored records directly and
  give the operator a page to view and edit them. Repairing data must be a
  first-class operator action.
- **Never render a dead or forbidden link**: Gate a link on the same condition
  its target enforces. Show plain text or an indicator when the condition fails.
  Render a page as each role when you test link visibility.
- **Operator decides genuine conflicts**: When an action hits a conflict the
  system cannot resolve, surface it and make the operator choose through a
  required field. Never auto-pick, and never move money on a guess.
- **Select only needed columns**: Never `SELECT *` (see
  [Database Queries](#database-queries)).
- **SQL table aliases**: Alias tables with the full singular word
  (`FROM
  listings AS listing`). When one query reads the same table more than
  once, give each occurrence a descriptive alias.
- **Name positional results at the boundary**: Destructure ordered arrays into
  domain names at the call that creates them. Validate an unguaranteed count
  before you name the values.
- **Use types where they remove noise**: Replace repeated inline shapes with a
  named type when that clarifies a boundary. Do not add a second vocabulary for
  one concept.
- **Never lose work — commit WIP even if broken**: Commit and push work in
  progress before you pause, hand off, or end a turn with a dirty tree. Mark a
  known-broken checkpoint in the commit message.
- **Answer every PR review thread you address**: Reply on each thread with the
  fix and its regression test, or with why it is not actionable. When a valid
  suggestion is out of scope, open an issue with enough context, then reply with
  the link.
- **"Actually broken" outranks "nice in a perfect world"**: A finding earns a
  fix when it names a concrete failure with real inputs and state. Decline
  perfect-world work with a short reason, or make it an issue. When consecutive
  review rounds name no new concrete failure, declare the review converged and
  hand the decision to a human.
- **Finish by rewriting the PR name and description**: Make the finished PR name
  and describe what was actually built, in plain words.
- **Final check**: Run `devenv shell deno task precommit` before you finish any
  job that changes code. It typechecks the test files too, so `deno check` plus
  `test:files` is not a substitute. A Markdown-only change needs no precommit.
  Run `deno task check:ste` on it instead.

## Stacked Pull Requests

Manage stacked pull requests with the official `gh stack` extension. The bottom
branch targets `main`, and every higher branch targets the branch directly below
it.

- Keep a stack at three to seven pull requests. Split a larger job into several
  stacks.
- Every layer must be independently green, reviewable, and useful on its own.
  Delete the implementation a layer replaces in that same layer.
- Review and merge from the bottom up. After a lower layer changes or merges,
  run `gh stack rebase` or `gh stack sync`.
- While a layer sits above another open layer, run targeted mutation tests for
  its source. Run the branch-level `precommit:mutation` gate after the lower
  layers merge and the layer reaches the bottom position.

## Offensive Programming — Never Suppress Errors

Fail loudly and immediately. Never suppress, default away, or paper over an
error.

- **Let errors propagate.** Do not wrap code in `try`/`catch` for extra safety.
- **A missing expected field from structured external data is a hard no to
  default away.** Validate external data at the boundary with a valibot schema,
  or check and throw the way `parseMessageId` does in
  `src/shared/sms/gateway.ts`.
- **Do not use `??` / `||` / `?.` to make a missing value someone else's
  problem.** These operators are for genuinely optional values only. An
  unchecked `!` or `as` cast claims a shape that nothing checked. Parse, do not
  pretend.
- **No empty `catch`, no catch-and-continue.** Catch only at the narrowest point
  that has a real recovery path, and re-raise otherwise. A `catch {}` is
  acceptable only when the fallback is the documented behavior, stated in a
  comment.
- **A function that looks something up must throw when it cannot.** Never return
  `null`, `""`, `0`, or `[]` as a "not found" stand-in. When "not found" is a
  genuine documented outcome, name it with the `*OrNull` suffix and a `| null`
  return type, and comment why the absence is expected.

## Simple Language — How We Talk To Users

Everything the system says to a person — error messages, hints, buttons,
warnings, empty states — must read at roughly **Simple Wikipedia** level. Say
everything the reader needs, in the shortest plain words.

All user-facing text lives in the message catalog at `src/locales/en/*.json`,
reached through `t("key")`. Changing what a user reads is a catalog edit, not a
template edit. Technical text follows
[Simplified Technical English](#simplified-technical-english--how-we-write-documentation)
instead.

- **One idea per sentence.** Split a sentence that joins two complete ideas.
- **Everyday words.** Prefer the word a ten-year-old uses.
- **Front-load the action.** "Type the listing name to confirm."
- **Active voice, addressed to "you".** "You must accept the terms to continue."
- **No implementation jargon.** Name a thing by what it does ("a one-way code"),
  not by how it is built.
- **Concise, not lossy.** Cut filler, never facts.
- **Errors** state the problem and the fix, as a full sentence. A
  confirm-by-typing error is always
  `"<Thing> name does not match. Please type the exact name to confirm."`
- **Warnings** before a destructive action open with `Warning:`.
- **Success messages** are short, past-tense confirmations.
- **Sentence case, not Title Case.** Align older keys when you touch them.
- **End full sentences with a full stop.** Never a label, button, or header.

`deno task check:copy` enforces the mechanical rules. The judgement is yours on
every copy change.

## Simplified Technical English — How We Write Documentation

Technical text follows ASD-STE100 Simplified Technical English. It covers
repository Markdown, procedures, release notes, reports, pull request titles and
descriptions, commit messages, `throw new Error(...)` messages, log lines,
`scripts/` and `cli/` output, and code comments. Copy inside the app follows
[Simple Language](#simple-language--how-we-talk-to-users) instead.

- Classify the passage first. Procedural text uses the imperative, one
  instruction per sentence, 20 words maximum per sentence. Descriptive text uses
  simple tenses, 25 words maximum per sentence.
- Use only these verb forms: infinitive, imperative, simple present, simple
  past, simple future, and the past participle as an adjective. No present
  perfect. No "-ing" verb forms.
- Write in the active voice.
- Use only `can`, `will`, and `must` as modals. Write "must" when the thing is
  required. Delete the word when the thing is optional.
- Keep the grammar complete. No contractions. No semicolons: write two
  sentences.
- Keep the word "that". Put the condition before the command: "If the test
  fails, read the log."
- Use a vertical list for more than two items or steps.
- One word carries one meaning through a whole document.
- Limit a noun chain to three words. Break a longer chain with prepositions.
- Delete a word that carries no fact (`simply`, `seamlessly`, `leverage`, "in
  order to").
- Use British spelling. Code, identifiers, file names, and quoted error messages
  keep their own spelling.
- Write the command or condition of a warning first, and the risk second.
- Code blocks, identifiers, CLI commands, file paths, and quoted error messages
  stay exactly as they are.

`deno task check:ste` enforces the mechanical patterns against per-document
baselines that only fall. Pass `--update` after a fix. The judgement is still
yours on every change.

## Designing New Systems

Before you design a new feature, read
[Designing new systems](docs/designing-systems.md) and the exemplar it names,
then copy the exemplar's shape. The qualities it demands: schema-tized, checked
forwards and backwards, pure and functional, modularised, well-named, built on
valibot and the standard libraries, curried, built for cold starts, efficient
SQL, decrypted-late PII.

## FP Imports

```typescript
import { compact, filter, map, pipe, reduce, unique } from "#fp";
```

The helpers `#fp` exports are documented on each definition in `src/fp.ts`. Read
those before you hand-roll a collection step. For an operation `#fp` does not
cover, use `@std/collections` directly, and wrap it in a curried `#fp` adapter
once more than one caller needs it. `@std/collections` has no `groupBy` export.
Use native `Object.groupBy` / `Map.groupBy`, or `#fp`'s `groupToMap`. Use
`for...of` instead of `forEach`, and `reduce` with a mutable accumulator instead
of an array spread.

## Code Duplication

`deno task cpd` runs jscpd at a 0% threshold, and the threshold is
non-negotiable. A flagged pair is one merge:

- Write the helper, or give the shared tail its parameter. Two functions that
  differ only in a value, a path, a field name, a message, or a callback are one
  function without its parameter yet.
- Never restructure code so the matcher stops matching while the two parallel
  implementations stay standing.
- After a dedup, search for the other places that now fold into the new helper.
- The one honest exception is a shared signature with nothing behind it: no
  shared call at all. Give that signature a named type instead.
- The renamed scan holds accepted matches in `.jscpd.renamed-baseline.json`. Add
  a pair only after you try the curry, with `deno task cpd:renamed --update`.
- Import blocks are the one sanctioned repeat. Wrap them in `jscpd:ignore-start`
  / `jscpd:ignore-end` markers.

`docs/test-duplication.md` measures the remaining steps. Read its counts as work
to do.

## Database Queries

- Prefer explicit, narrow column lists. Never `SELECT *`.
- A whole-table read is only for an admin collection page, and even then only
  the columns the page displays. Everything else is bounded by id, by key, or
  with a `WHERE`/`LIMIT`.
- Full-row reads are the exceptions: an entity cache that also backs
  single-record reads (`getAllListings`), full-table backup and restore, and
  `table.read.one` / `read.many` in `table-reader.ts`. Outside these, a caller
  that needs many columns lists them explicitly.

### Transactions and Batches

Use the helpers in `src/shared/db/client.ts` rather than `getDb().batch` or
`getDb().transaction` directly, so query logging and cache invalidation stay
automatic.

- **Batch** — multiple statements, no logic between them, and no result feeds a
  later statement. Use `executeBatch`, `executeBatchWithResults`, `queryBatch`,
  or `queryBatchPrimary`. One statement is not a batch: use `queryOnePrimary` or
  `queryAllPrimary`.
- **Interactive transaction** — a later statement depends on an earlier result,
  or a guard must abort and undo everything. `withTransaction` hands the
  callback a `TxScope`. Keep the work inside it tight.

## Scripts

- `agent-diagnose` — read-only diagnostics for processes and check states (see
  [Precommit status records](docs/precommit-status.md))
- `deno task start` — run the server
- `deno task dev` — run the server with `--watch`. Static assets build once at
  the start. The dev database is the gitignored `local.db` beside its `.db-key`.
  `:memory:` is not a valid dev URL
- `deno task serve` — the bare server command that `start` and `dev` call
- `deno task test` — run the full suite
- `deno task test:coverage` — run the full suite with coverage
- `deno task test:files <file>...` — run only the given files with the full
  runner's setup. Arguments go through to `deno test`, so `--filter` and Feature
  files work
- `deno task cov:files <file>... [--only <part>]` — same setup as `test:files`,
  then print the lines and branches this run left uncovered
- `deno task specs` — run every Cucumber Feature. Reports land under `reports/`
- `deno task specs:check` — parse and validate every Feature
- `deno task specs:files <feature>... [--tags <expression>]` — run selected
  Features
- `deno task lint` — format and lint code with Biome (`check --write
  --unsafe`). Format through this task. Fixable findings — including
  unsafe-fix ones like unused imports — self-heal here instead of failing.
  Warn and info findings are left to the strict `lint:ci` gate
- `deno task lint:ci` — the strict read-only lint that precommit runs
- `deno task build:edge` — build for Bunny Edge deployment
- `deno task check:file-lengths` — the 500-line limit over every source tree,
  against the accepted list that only shrinks. Pass `--update` after a split.
  The update refuses a rise. The 400-line aim is policy, not a gate: a file
  slightly over it owes a splitting issue
- `deno task check:ste` — mechanical STE rules over the Markdown, against
  baselines that only fall. Pass `--update` after a fix
- `deno task grade:code [<file-or-dir>] [--csv <path>] [--no-jev]` — score
  source files against these rules. With no target, it grades every module under
  `src/`. `--no-jev` runs the mechanical checks only. A grade is advice, not a
  gate
- `deno task precommit` — all checks (typecheck, lint, tests)
- `deno task precommit:mutation` — the branch mutation gate: every `src/` file
  this branch changed, 100% kill rate (see
  [Mutation Testing](#mutation-testing))
- `deno task mutation <source-glob> <test-glob>` — mutation-test a module on
  demand (see [Mutation Testing](#mutation-testing))

## Running Individual Test Files

Do not use `deno task test -- --filter` to debug one test. It loads the entire
suite. Use `deno task test:files` instead. It runs only the files you pass,
builds the static assets when they changed, and starts stripe-mock:

```bash
deno task test:files test/shared/dates.test.ts
deno task test:files test/shared/dates.test.ts --filter "formats date"
deno task test:files specs/payments/capacity-after-payment.feature
```

Both runners skip the asset build when nothing it reads has changed.

For a pure unit test that imports neither the app nor Stripe, run `deno test`
directly on the file. Always keep `--preload ./test/test-utils/preload.ts`.
Without it, every `t()` call throws. For a test that needs stripe-mock, start
the mock first and set the port:

```bash
deno test --no-check --allow-all --preload ./test/test-utils/preload.ts test/shared/dates.test.ts
STRIPE_MOCK_HOST=localhost STRIPE_MOCK_PORT=12111 deno test --no-check --allow-all --preload ./test/test-utils/preload.ts test/scripts/stripe-mock/ports.test.ts
```

## Environment Variables

Environment variables are configured as **Bunny native secrets** in the Bunny
Edge Scripting dashboard. They are read at runtime via `process.env`. Three are
required for every site: `DB_URL` (database URL), `DB_TOKEN` (database auth
token), and `DB_ENCRYPTION_KEY` (32-byte base64 key). A new variable is a last
resort, because each one must be set by hand on every site (see
[Preferences](#preferences)).

Every optional variable is documented in
[Environment variables](docs/env-vars.md).

## Test Framework

Use helpers from `#test-utils` instead of defining local ones.

### Cucumber Acceptance Specifications

Cucumber owns user journeys and observable business rules. Direct Deno tests own
pure logic, technical contracts, and everything a story cannot prove. A Cucumber
journey never supplies the only coverage of a production line or branch. See
[E2E_TESTS.md](E2E_TESTS.md) for the full rules.

A test that moves into a story is a replacement. Build the old test's claim list
from `git diff "$base" HEAD -- "$file"` and `git show "$base:$file"`, never from
the new file. Every claim lands in the story, in a direct test you keep, or in a
drop you state out loud.

## Test Quality Standards

- Prefer assertions that fail under realistic mutants: exact values, object
  shape, persisted rows. Avoid `toBeTruthy()`, compound booleans, and
  presence-only checks. Run `deno task test:quality-audit` when you bulk-add
  tests.
- For critical flows, cover negative paths, idempotency, concurrency, and
  metamorphic cases: webhook replay does not double-credit, capacity cannot go
  below zero, role downgrades remove access, PII stays encrypted or absent from
  responses.
- A test that reserves a real resource — a port, a lock file, a fixed path —
  shares it with every parallel suite. Make the test tell a stolen resource from
  its own (`retryWhilePortTaken`), or remove the sharing.

### Mutation Testing

`deno task mutation` mutates operators in the source and checks whether the
tests fail. A mutant the tests still pass on is a real gap. How the runner works
is in [Mutation testing](docs/mutation-testing.md).

```bash
deno task mutation src/shared/dates.ts test/shared/dates.test.ts
deno task mutation 'src/shared/forms/definition.ts' 'test/shared/forms/definition/*.test.ts' --exhaustive
```

The tool is targeted: run it on the module you harden. Time-box it. A manual run
must finish in about ten minutes. When a run needs longer, stop it, and rely on
the direct tests around the method you changed. A small edit owes those tests,
not a mutation run, and a review that asks for more gets that answer.

Survivors on a file you touch are yours to fix, even on lines you did not
change. Write the assertion that kills the mutant, or record it in
`scripts/mutation/equivalent-mutants/` with a proof that no input can
distinguish it.

`deno task precommit:mutation` is the branch gate. Run it before you merge a
branch that changes `src/` files.

### Fast Tests

The suite prints each test slower than 500ms after every run. Treat entries as
regressions to fix.

- The full runner shares isolates between test files. Never register a global
  BDD hook at module level, and never rely on a virgin isolate: reset the state
  you change, and pin what you assert on. A file that needs its own isolate
  carries `// test-groups: run-alone`. `deno task test:files` never groups.
  `TICKETS_TEST_UNGROUPED=1 deno task test` runs every file in its own isolate
  to rule grouping out.
- Never run repo tooling as a subprocess inside a test.
- Never sleep for real. Wrap retry paths in `withVirtualBackoff` from
  `#test-utils`.
- Render once, assert many: use `cachedAdminPage(path)` for a page in its
  default fixture state.
- Seed volume with a batch, not a loop (`seedFillerAttendees`).
- Shard inherently heavy suites across workers
  (`test/integration/db/migration-restore/`).
- Keep heavy SDKs out of module load. Import them dynamically on first use
  (`stripe.ts`, `sentry.ts`).
- `expect(bigHtml).toContain(...)` is safe: `#test-utils` overrides the matcher,
  so it only formats on failure.
